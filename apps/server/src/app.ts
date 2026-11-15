import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import pino, { type Logger } from 'pino';
import { registerApi } from './api.js';
import type { Config } from './config.js';
import { CoverageService } from './coverage-service.js';
import { createMetrics, type Metrics } from './metrics.js';
import { AnalysisPipeline, type PipelineHooks, type ProxyJob } from './pipeline.js';
import { registerProxyRoutes } from './proxy.js';
import { RunManager } from './runs.js';
import { SchemaRegistry } from './schema-registry.js';
import { SqliteStorage } from './storage/sqlite.js';
import type { Storage } from './storage/storage.js';

export interface AppOptions {
  /** Inject a storage (tests). Default: from config. */
  storage?: Storage;
  logger?: Logger;
  pipelineHooks?: PipelineHooks;
  beforeEnqueue?: (job: ProxyJob) => void;
}

export interface GqlcovApp {
  config: Config;
  proxy: FastifyInstance;
  admin: FastifyInstance;
  storage: Storage;
  schemas: SchemaRegistry;
  runs: RunManager;
  pipeline: AnalysisPipeline;
  metrics: Metrics;
  log: Logger;
  /** Load schemas and start timers (does not listen). */
  init(): Promise<void>;
  listen(): Promise<{ proxyUrl: string; adminUrl: string }>;
  close(): Promise<void>;
}

export function createLogger(config: Config): Logger {
  const paths = config.logging.maskHeaders.flatMap((h) => [
    `req.headers["${h.toLowerCase()}"]`,
    `headers["${h.toLowerCase()}"]`,
  ]);
  return pino({ level: config.logging.level, redact: { paths, censor: '***' } });
}

function createStorage(config: Config): Storage {
  if (config.storage.driver === 'postgres') {
    throw new Error(
      'storage.driver=postgres is planned for stage 2 (schema is portable); use sqlite for now',
    );
  }
  return new SqliteStorage(config.storage.url);
}

function defaultWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '../../web/dist'),
    resolve(here, '../web'),
    resolve(process.cwd(), 'apps/web/dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function createApp(config: Config, baseDir: string, options: AppOptions = {}): GqlcovApp {
  const log = options.logger ?? createLogger(config);
  const storage = options.storage ?? createStorage(config);
  const metrics = createMetrics();
  const schemas = new SchemaRegistry(config, baseDir, storage, log);
  const runs = new RunManager(config, storage, schemas, log);
  const pipeline = new AnalysisPipeline(
    config,
    storage,
    schemas,
    runs,
    metrics,
    log,
    options.pipelineHooks,
  );
  const coverage = new CoverageService(config, storage, schemas, pipeline);

  // --- proxy (hot path): no request logging, raw bodies ---------------------
  const proxy = Fastify({
    loggerInstance: log.child({ component: 'proxy' }) as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.server.bodyLimitBytes,
    keepAliveTimeout: 65_000,
  });
  proxy.get('/healthz', async () => ({ status: 'ok' }));
  registerProxyRoutes(proxy, {
    config,
    pipeline,
    metrics,
    log,
    beforeEnqueue: options.beforeEnqueue,
  });

  // --- admin: REST API, UI, metrics ------------------------------------------
  const admin = Fastify({
    loggerInstance: log.child({ component: 'admin' }) as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  admin.setValidatorCompiler(validatorCompiler);
  admin.setSerializerCompiler(serializerCompiler);
  admin.addContentTypeParser(
    ['text/plain', 'application/graphql'],
    { parseAs: 'string' },
    (_r, body, done) => done(null, body),
  );

  void admin.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'GraphQL Coverage Proxy API',
        version: '0.1.0',
        description: '«Сеть глазами Бога» — coverage of a GraphQL schema by tests.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: config.auth.token ? [{ bearer: [] }] : [],
    },
    transform: jsonSchemaTransform,
  });
  void admin.register(fastifySwaggerUi, { routePrefix: '/docs' });

  admin.addHook('onRequest', async (req, reply) => {
    const token = config.auth.token;
    if (!token || !req.url.startsWith('/api/')) return;
    const auth = req.headers.authorization;
    const q = new URL(req.url, 'http://x').searchParams.get('token');
    if (auth === `Bearer ${token}` || q === token) return;
    return reply.code(401).send({ error: 'unauthorized', message: 'Bearer token required' });
  });

  admin.get('/healthz', async () => ({ status: 'ok' }));
  admin.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await storage.ping();
      checks.storage = 'ok';
    } catch (e) {
      checks.storage = (e as Error).message;
    }
    for (const t of config.targets)
      checks[`schema:${t.name}`] = schemas.get(t.name)
        ? 'ok'
        : (schemas.lastError(t.name)?.message ?? 'not loaded');
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? 'ready' : 'not_ready', checks, queue: pipeline.length });
  });
  admin.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  void admin.register(async (scope) =>
    registerApi(scope, { config, storage, schemas, runs, pipeline, coverage }),
  );

  const webDir = config.server.webDir ? resolve(baseDir, config.server.webDir) : defaultWebDir();
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    void admin.register(fastifyStatic, { root: webDir, wildcard: false, index: ['index.html'] });
    admin.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.code(404).send({ error: 'not_found', message: `${req.method} ${req.url}` });
      }
      return reply.sendFile('index.html');
    });
  }

  let retentionTimer: NodeJS.Timeout | null = null;
  const app: GqlcovApp = {
    config,
    proxy,
    admin,
    storage,
    schemas,
    runs,
    pipeline,
    metrics,
    log,
    async init() {
      await schemas.start();
      pipeline.start();
      runs.start();
      const days = config.retention.operationLogDays;
      if (days > 0) {
        const purge = () =>
          storage
            .deleteLogsBefore(Date.now() - days * 86_400_000)
            .then((n) => n && log.info({ deleted: n }, 'retention: old operation logs removed'))
            .catch((e: Error) => log.warn({ err: e.message }, 'retention failed'));
        void purge();
        retentionTimer = setInterval(() => void purge(), config.retention.intervalSec * 1000);
        retentionTimer.unref();
      }
    },
    async listen() {
      const host = config.server.host;
      const proxyUrl = await proxy.listen({ port: config.server.proxyPort, host });
      const adminUrl = await admin.listen({ port: config.server.adminPort, host });
      return { proxyUrl, adminUrl };
    },
    async close() {
      if (retentionTimer) clearInterval(retentionTimer);
      runs.stop();
      schemas.stop();
      await proxy.close();
      await pipeline.stop();
      await admin.close();
      await storage.close();
    },
  };
  return app;
}
