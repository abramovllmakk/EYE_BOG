import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { Busboy, type BusboyInstance } from '@fastify/busboy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'undici';
import type { Logger } from 'pino';
import type { Config, TargetConfig } from './config.js';
import type { Metrics } from './metrics.js';
import type { AnalysisPipeline, ProxyJob, Transport } from './pipeline.js';
import type { RunMeta } from './runs.js';

/** RFC 7230 hop-by-hop headers (plus ones undici manages itself). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyContext {
  config: Config;
  pipeline: AnalysisPipeline;
  metrics: Metrics;
  log: Logger;
  /** Test hook: everything before forwarding may throw; proxying must still work. */
  beforeEnqueue?: (job: ProxyJob) => void;
}

const header = (h: IncomingHttpHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export function extractMeta(config: Config, h: IncomingHttpHeaders, pathRunId?: string): RunMeta {
  const n = config.runs.headers;
  return {
    runId: pathRunId ?? header(h, n.runId),
    environment: header(h, n.environment),
    branch: header(h, n.branch),
    build: header(h, n.build),
    commit: header(h, n.commit),
    team: header(h, n.team),
    // X-Test-Suite describes a single test, not the run: it is stored per operation/test only.
  };
}

/** Headers sent upstream: hop-by-hop and X-Coverage-* removed, Host rewritten, config rules applied. */
export function upstreamHeaders(
  config: Config,
  target: TargetConfig,
  incoming: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const connectionTokens = new Set(
    (header(incoming, 'connection') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const prefixes = config.runs.stripHeaderPrefixes.map((p) => p.toLowerCase());
  const remove = new Set(target.headers.remove.map((h) => h.toLowerCase()));
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(key) || connectionTokens.has(key) || key === 'host')
      continue;
    if (prefixes.some((p) => key.startsWith(p)) || remove.has(key)) continue;
    out[key] = v;
  }
  for (const [k, v] of Object.entries(target.headers.add)) {
    if (out[k.toLowerCase()] === undefined) out[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(target.headers.override)) out[k.toLowerCase()] = v;
  out.host = new URL(target.url).host;
  return out;
}

function responseHeaders(
  h: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** Read only the `operations` field of a multipart request (files are skipped, never buffered). */
function extractOperations(
  stream: Readable,
  headers: IncomingHttpHeaders,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      resolve(v);
    };
    let bb: BusboyInstance;
    try {
      bb = Busboy({
        headers: headers as IncomingHttpHeaders & { 'content-type': string },
        limits: { fieldSize: 10 * 1024 * 1024 },
      });
    } catch {
      return resolve(undefined);
    }
    bb.on('field', (name, value) => {
      if (name === 'operations') done(value);
    });
    bb.on('file', (_n, file) => file.resume());
    bb.on('finish', () => done(undefined));
    bb.on('error', () => done(undefined));
    const onData = (chunk: Buffer) => {
      if (!settled) bb.write(chunk);
    };
    stream.on('data', onData);
    stream.once('end', () => {
      if (!settled) bb.end();
    });
  });
}

const isJsonType = (ct: string | undefined) => !!ct && /json/i.test(ct);

export function registerProxyRoutes(app: FastifyInstance, ctx: ProxyContext): void {
  const { config, metrics, log } = ctx;
  const pools = new Map<string, Pool>();
  for (const t of config.targets) {
    pools.set(
      t.name,
      new Pool(new URL(t.url).origin, { connections: 256, keepAliveTimeout: 30_000 }),
    );
  }
  app.addHook('onClose', async () => {
    await Promise.all([...pools.values()].map((p) => p.close()));
  });

  // Raw bodies: the proxy must forward bytes untouched.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('multipart/form-data', (_req, payload, done) => done(null, payload));
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: config.server.bodyLimitBytes },
    (_req, body, done) => done(null, body),
  );

  const byName = new Map(config.targets.map((t) => [t.name, t]));
  const handler =
    (resolveTarget: (req: FastifyRequest) => TargetConfig | undefined) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const target = resolveTarget(req);
      if (!target) return reply.code(404).send({ errors: [{ message: 'Unknown proxy target' }] });
      await forward(req, reply, target);
    };

  const methods = ['GET', 'POST', 'OPTIONS'] as const;
  const first = config.targets[0]!;
  app.route({ method: [...methods], url: '/graphql', handler: handler(() => first) });
  app.route({ method: [...methods], url: '/proxy/:runId/graphql', handler: handler(() => first) });
  app.route({
    method: [...methods],
    url: '/t/:target/graphql',
    handler: handler((r) => byName.get((r.params as { target: string }).target)),
  });
  app.route({
    method: [...methods],
    url: '/t/:target/proxy/:runId/graphql',
    handler: handler((r) => byName.get((r.params as { target: string }).target)),
  });
  for (const t of config.targets) {
    if (t.route && t.route !== '/graphql')
      app.route({ method: [...methods], url: t.route, handler: handler(() => t) });
  }

  async function forward(
    req: FastifyRequest,
    reply: FastifyReply,
    target: TargetConfig,
  ): Promise<void> {
    const t0 = performance.now();
    const raw = req.raw;
    const method = req.method;
    const contentType = header(req.headers, 'content-type');
    const isMultipart =
      !!contentType && contentType.toLowerCase().startsWith('multipart/form-data');
    const search = raw.url!.includes('?') ? raw.url!.slice(raw.url!.indexOf('?')) : '';
    const targetUrl = new URL(target.url);
    const path = targetUrl.pathname + (search || targetUrl.search);

    let body: Buffer | Readable | undefined;
    let operations: Promise<string | undefined> | undefined;
    if (isMultipart) {
      const incoming = req.body as IncomingMessage;
      const pass = new PassThrough();
      incoming.pipe(pass);
      operations = extractOperations(incoming, req.headers).catch(() => undefined);
      body = pass;
    } else if (method !== 'GET' && method !== 'HEAD') {
      body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    }

    reply.hijack();
    const res = reply.raw;
    const tUp = performance.now();
    let status = 502;
    let responseBody: Buffer | undefined;
    try {
      const upstream = await pools.get(target.name)!.request({
        path,
        method: method as 'GET' | 'POST' | 'OPTIONS',
        headers: upstreamHeaders(config, target, req.headers),
        body,
        headersTimeout: target.timeoutMs,
        bodyTimeout: 0,
      });
      status = upstream.statusCode;
      const tHeaders = performance.now();
      res.writeHead(upstream.statusCode, responseHeaders(upstream.headers));
      const headerWork = performance.now() - tHeaders;
      const limit = config.queue.responseInspectLimitBytes;
      const inspect =
        method !== 'OPTIONS' &&
        isJsonType(header(upstream.headers as IncomingHttpHeaders, 'content-type')) &&
        !upstream.headers['content-encoding'];
      const chunks: Buffer[] = [];
      let size = 0;
      if (inspect) {
        upstream.body.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= limit) chunks.push(c);
        });
      }
      try {
        await pipeline(upstream.body, res);
      } catch (e) {
        // Client went away or upstream aborted mid-stream: nothing more to send.
        log.debug({ err: (e as Error).message }, 'response stream ended early');
        if (!res.writableEnded) res.destroy();
      }
      const tEnd = performance.now();
      if (inspect && size <= limit) responseBody = Buffer.concat(chunks);
      metrics.upstreamDuration.observe({ target: target.name }, (tEnd - tUp - headerWork) / 1000);
      // Overhead = time before the upstream request + header rewrite after it.
      metrics.proxyOverhead.observe({ target: target.name }, (tUp - t0 + headerWork) / 1000);
    } catch (e) {
      metrics.upstreamErrors.inc({ target: target.name });
      log.warn({ target: target.name, err: (e as Error).message }, 'upstream request failed');
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            errors: [{ message: `Bad gateway: upstream ${target.name} unreachable` }],
          }),
        );
      } else res.destroy();
    }
    metrics.proxyRequests.inc({ target: target.name, status: String(status) });
    if (method === 'OPTIONS') return;

    // Everything below is off the critical path (response already sent) and fail-open.
    try {
      const transport: Transport = isMultipart
        ? 'multipart'
        : method === 'GET'
          ? 'get'
          : Buffer.isBuffer(body) && body[0] === 0x5b
            ? 'batch'
            : 'post';
      const job: ProxyJob = {
        target: target.name,
        ts: Date.now(),
        transport,
        method,
        contentType,
        body: Buffer.isBuffer(body) ? body : undefined,
        query: method === 'GET' ? (req.query as Record<string, string>) : undefined,
        operationsJson: operations ? ((await operations) ?? '') : undefined,
        headers: req.headers,
        meta: extractMeta(config, req.headers, (req.params as { runId?: string }).runId),
        test: {
          name: header(req.headers, config.runs.headers.testName),
          suite: header(req.headers, config.runs.headers.testSuite),
        },
        httpStatus: status,
        responseBody,
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      ctx.beforeEnqueue?.(job);
      ctx.pipeline.enqueue(job);
    } catch (e) {
      metrics.errors.inc({ component: 'proxy-enqueue' });
      log.error(
        { err: (e as Error).message },
        'failed to enqueue request for analysis (request was proxied)',
      );
    }
  }
}
