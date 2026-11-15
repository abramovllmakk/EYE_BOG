import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { GraphQLRequest } from '@gqlcov/core';
import type { TargetConfig } from './config.js';
import { extractMeta, headerText, upstreamHeaders, type ProxyContext } from './proxy.js';

/** Messages that carry a GraphQL document in both supported protocols. */
const START_TYPES = new Set(['subscribe', 'start']); // graphql-transport-ws / subscriptions-transport-ws

interface Route {
  target: TargetConfig;
  runId?: string;
}

/** Resolve the proxy route of an upgrade request (same paths as HTTP). */
function route(ctx: ProxyContext, url: string): Route | null {
  const path = url.split('?')[0]!;
  const targets = ctx.config.targets;
  const byName = (n: string) => targets.find((t) => t.name === n);
  let m: RegExpMatchArray | null;
  if (path === '/graphql') return { target: targets[0]! };
  if ((m = path.match(/^\/proxy\/([^/]+)\/graphql$/)))
    return { target: targets[0]!, runId: decodeURIComponent(m[1]!) };
  if ((m = path.match(/^\/t\/([^/]+)\/graphql$/)))
    return byName(m[1]!) ? { target: byName(m[1]!)! } : null;
  if ((m = path.match(/^\/t\/([^/]+)\/proxy\/([^/]+)\/graphql$/))) {
    return byName(m[1]!) ? { target: byName(m[1]!)!, runId: decodeURIComponent(m[2]!) } : null;
  }
  const custom = targets.find((t) => t.route === path);
  return custom ? { target: custom } : null;
}

const toWsUrl = (http: string, search: string) => {
  const u = new URL(http);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (search) u.search = search;
  return u.toString();
};

/** Close codes that may not be sent on the wire are mapped to a generic one. */
const sendable = (code: number) => (code === 1005 || code === 1006 || code === 1015 ? 1000 : code);

/**
 * Transparent WebSocket proxy for GraphQL subscriptions: frames are relayed unchanged in both
 * directions; `subscribe` / `start` payloads are copied to the analysis queue (fail-open).
 */
export function registerWsProxy(app: FastifyInstance, ctx: ProxyContext): void {
  const selected = new WeakMap<IncomingMessage, string | false>();
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (_protocols, req) => selected.get(req) ?? false,
  });

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const r = route(ctx, req.url ?? '/');
    if (!r) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const search = req.url!.includes('?') ? req.url!.slice(req.url!.indexOf('?')) : '';
    const protocols = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    // ws negotiates its own handshake headers and Host.
    const headers = Object.fromEntries(
      Object.entries(upstreamHeaders(ctx.config, r.target, req.headers)).filter(
        ([k]) => !k.startsWith('sec-websocket-') && k !== 'host',
      ),
    );

    const upstream = new WebSocket(toWsUrl(r.target.url, search), protocols, {
      headers: headers as Record<string, string>,
      handshakeTimeout: r.target.timeoutMs,
    });
    const pending: { data: RawData; binary: boolean }[] = [];
    let client: WebSocket | null = null;

    upstream.once('unexpected-response', (_req, res) => {
      socket.end(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? 'Bad Gateway'}\r\n\r\n`);
      upstream.terminate();
    });
    upstream.once('error', (e) => {
      ctx.metrics.upstreamErrors.inc({ target: r.target.name });
      ctx.log.warn({ target: r.target.name, err: e.message }, 'upstream websocket failed');
      if (!client) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.close(1011, 'upstream error');
    });
    upstream.on('message', (data, binary) => {
      if (client?.readyState === WebSocket.OPEN) client.send(data, { binary });
      else pending.push({ data, binary });
    });
    upstream.once('open', () => {
      selected.set(req, upstream.protocol || false);
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        for (const p of pending.splice(0)) ws.send(p.data, { binary: p.binary });
        ctx.metrics.proxyRequests.inc({ target: r.target.name, status: '101' });
        ws.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          if (!binary) inspect(r, req, data);
        });
        ws.on(
          'close',
          (code, reason) =>
            upstream.readyState <= WebSocket.OPEN && upstream.close(sendable(code), reason),
        );
        upstream.on(
          'close',
          (code, reason) => ws.readyState <= WebSocket.OPEN && ws.close(sendable(code), reason),
        );
        ws.on('error', () => upstream.terminate());
      });
    });
  });

  function inspect(r: Route, req: IncomingMessage, data: RawData): void {
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; payload?: GraphQLRequest };
      if (!msg.type || !START_TYPES.has(msg.type) || !msg.payload) return;
      const h = ctx.config.runs.headers;
      const header = (n: string) => headerText(req.headers, n);
      ctx.pipeline.enqueue({
        target: r.target.name,
        ts: Date.now(),
        transport: 'ws',
        method: 'WS',
        requests: [
          {
            query: msg.payload.query ?? null,
            operationName: msg.payload.operationName ?? null,
            variables: msg.payload.variables ?? null,
            extensions: msg.payload.extensions ?? null,
          },
        ],
        headers: req.headers,
        meta: extractMeta(ctx.config, req.headers, r.runId),
        test: { name: header(h.testName), suite: header(h.testSuite) },
        httpStatus: 101,
        latencyMs: null,
      });
    } catch (e) {
      ctx.metrics.errors.inc({ component: 'ws-inspect' });
      ctx.log.debug({ err: (e as Error).message }, 'non-JSON websocket frame ignored');
    }
  }

  app.addHook('onClose', async () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
}
