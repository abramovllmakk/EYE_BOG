import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { request } from 'undici';
import { startDemoServer } from '@gqlcov/demo-server';
import { createApp, type AppOptions, type GqlcovApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';

export const DEMO_SDL = fileURLToPath(
  new URL('../../../demo/server/src/schema.graphql', import.meta.url),
);

export const portOf = (s: Server) => (s.address() as AddressInfo).port;

export interface EchoRecord {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Upstream that records what it received and answers with a fixed GraphQL JSON body. */
export async function startEcho(): Promise<{
  server: Server;
  url: string;
  received: EchoRecord[];
}> {
  const received: EchoRecord[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-upstream', 'echo');
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.end('{"data":{"ok":true}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${portOf(server)}/graphql`, received };
}

export interface Harness {
  app: GqlcovApp;
  proxyUrl: string;
  adminUrl: string;
  demoUrl: string;
  echo: Awaited<ReturnType<typeof startEcho>>;
  logs: string[];
  close(): Promise<void>;
  /** POST JSON to the proxy. */
  gql(
    body: unknown,
    headers?: Record<string, string>,
    path?: string,
  ): Promise<{ status: number; headers: Record<string, unknown>; text: string }>;
  api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }>;
}

export async function startHarness(
  overrides: Record<string, unknown> = {},
  options: AppOptions & {
    demo?: { disableIntrospection?: boolean };
    extraTargets?: unknown[];
  } = {},
): Promise<Harness> {
  const demo = await startDemoServer(0, options.demo);
  const demoUrl = `http://127.0.0.1:${portOf(demo)}/graphql`;
  const echo = await startEcho();
  const logs: string[] = [];
  const logger = pino(
    {
      level: 'debug',
      redact: { paths: ['req.headers.authorization', 'headers.authorization'], censor: '***' },
    },
    new Writable({
      write(chunk: Buffer, _e, cb) {
        logs.push(chunk.toString());
        cb();
      },
    }),
  );
  const { config, baseDir } = parseConfig({
    server: { proxyPort: 0, adminPort: 0, host: '127.0.0.1' },
    storage: { url: ':memory:' },
    queue: { flushIntervalMs: 50 },
    targets: [
      { name: 'demo', url: demoUrl },
      {
        name: 'echo',
        url: echo.url,
        schema: { source: 'sdl', file: DEMO_SDL },
        headers: {
          add: { 'x-added': 'added', 'x-keep': 'default' },
          override: { authorization: 'Bearer stand-token' },
          remove: ['x-drop-me'],
        },
      },
      ...(options.extraTargets ?? []),
    ],
    ...overrides,
  });
  const app = createApp(config, baseDir, { logger, ...options });
  await app.init();
  const { proxyUrl, adminUrl } = await app.listen();
  const h: Harness = {
    app,
    proxyUrl,
    adminUrl,
    demoUrl,
    echo,
    logs,
    async close() {
      await app.close();
      await new Promise((r) => demo.close(r));
      await new Promise((r) => echo.server.close(r));
    },
    async gql(body, headers = {}, path = '/graphql') {
      const res = await request(proxyUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.statusCode, headers: res.headers, text: await res.body.text() };
    },
    async api(method, path, body) {
      const res = await request(adminUrl + path, {
        method: method as 'GET',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.body.text();
      return { status: res.statusCode, json: (text ? JSON.parse(text) : null) as never };
    },
  };
  return h;
}

/** Headers that legitimately differ between two responses. */
export const VOLATILE = new Set([
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'x-request-id',
]);
export const stable = (h: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !VOLATILE.has(k.toLowerCase())));
