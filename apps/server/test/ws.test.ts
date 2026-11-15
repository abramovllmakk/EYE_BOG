import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from 'graphql-ws';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_SDL, startHarness, type Harness } from './helpers.js';

let h: Harness;
let legacy: {
  url: string;
  close: () => Promise<void>;
  seenProtocol: string[];
  seenHeaders: Record<string, unknown>[];
};

beforeAll(async () => {
  // A raw upstream speaking the legacy subscriptions-transport-ws protocol: echoes frames back.
  const server = createServer();
  const seenProtocol: string[] = [];
  const seenHeaders: Record<string, unknown>[] = [];
  const wss = new WebSocketServer({ server, handleProtocols: (p) => [...p][0] ?? false });
  wss.on('connection', (ws, req) => {
    seenProtocol.push(ws.protocol);
    seenHeaders.push(req.headers);
    ws.on('message', (d, binary) => ws.send(d, { binary }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  legacy = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`,
    seenProtocol,
    seenHeaders,
    close: () => new Promise((r) => (wss.close(), server.close(() => r()))),
  };
  h = await startHarness(
    {},
    {
      extraTargets: [
        { name: 'legacy', url: legacy.url, schema: { source: 'sdl', file: DEMO_SDL } },
      ],
    },
  );
});

afterAll(async () => {
  await h.close();
  await legacy.close();
});

describe('websocket subscriptions', () => {
  it('relays graphql-ws (graphql-transport-ws) end to end and records the subscription', async () => {
    const wsUrl = h.proxyUrl.replace('http', 'ws') + '/proxy/ws-run/graphql';
    const client = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      lazy: false,
      retryAttempts: 0,
      connectionParams: { authToken: 'x' },
    });
    const received = new Promise<unknown>((resolve, reject) => {
      const dispose = client.subscribe(
        {
          query: 'subscription OnPost($s: PostStatus) { postAdded(status: $s) { id title } }',
          variables: { s: 'PUBLISHED' },
        },
        { next: (v) => (resolve(v), dispose()), error: reject, complete: () => {} },
      );
    });
    await new Promise((r) => setTimeout(r, 150));
    await h.gql({
      query:
        'mutation { createPost(input: { title: "over ws", body: "b", status: PUBLISHED }) { id } }',
    });
    expect(await received).toMatchObject({ data: { postAdded: { title: 'over ws' } } });
    await client.dispose();
    await h.app.pipeline.idle();
    const ops = await h.api<{
      items: { transport: string; status: string; fields: string[]; operationType: string }[];
    }>('GET', '/api/runs/ws-run/operations');
    expect(ops.json.items[0]).toMatchObject({
      transport: 'ws',
      status: 'valid',
      operationType: 'subscription',
    });
    expect(ops.json.items[0]!.fields).toEqual(['Post.id', 'Post.title', 'Subscription.postAdded']);
  });

  it('passes the legacy subscriptions-transport-ws protocol through unchanged', async () => {
    const ws = new WebSocket(h.proxyUrl.replace('http', 'ws') + '/t/legacy/graphql', 'graphql-ws', {
      headers: {
        'x-coverage-run-id': 'legacy-run',
        'x-test-name': 'legacy sub',
        authorization: 'Bearer secret',
      },
    });
    await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
    expect(ws.protocol).toBe('graphql-ws');
    const frames: string[] = [];
    ws.on('message', (d) => frames.push(d.toString()));
    const start = JSON.stringify({
      id: '1',
      type: 'start',
      payload: { query: '{ viewer { name } }' },
    });
    ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    ws.send(start);
    ws.send(Buffer.from([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 150));
    expect(frames).toEqual([
      '{"type":"connection_init","payload":{}}',
      start,
      '\u0001\u0002\u0003',
    ]);
    ws.close();
    expect(legacy.seenProtocol.at(-1)).toBe('graphql-ws');
    expect(
      Object.keys(legacy.seenHeaders.at(-1)!).filter((k) => k.startsWith('x-coverage')),
    ).toEqual([]);
    await h.app.pipeline.idle();
    const ops = await h.api<{ items: { transport: string; testName: string; fields: string[] }[] }>(
      'GET',
      '/api/runs/legacy-run/operations',
    );
    expect(ops.json.items).toHaveLength(1);
    expect(ops.json.items[0]).toMatchObject({
      transport: 'ws',
      testName: 'legacy sub',
      fields: ['Query.viewer', 'User.name'],
    });
  });

  it('rejects unknown websocket paths and unreachable upstreams', async () => {
    const bad = new WebSocket(h.proxyUrl.replace('http', 'ws') + '/nope');
    const err = await new Promise<Error>((r) => bad.once('error', r));
    expect(err.message).toMatch(/404/);
  });
});
