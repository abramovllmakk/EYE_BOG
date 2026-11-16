import { createServer, type Server } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_SDL, portOf, startHarness, type Harness } from './helpers.js';

/** Upstream that compresses every JSON response, like most production GraphQL gateways. */
let upstream: Server;
let h: Harness;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const json = body.includes('broken')
        ? { errors: [{ message: 'Internal error' }], data: null }
        : { data: { viewer: { id: '1' } } };
      const raw = Buffer.from(JSON.stringify(json));
      const br = req.headers['x-want'] === 'br';
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': br ? 'br' : 'gzip',
      });
      res.end(br ? brotliCompressSync(raw) : gzipSync(raw));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  h = await startHarness(
    {},
    {
      extraTargets: [
        {
          name: 'gz',
          url: `http://127.0.0.1:${portOf(upstream)}/graphql`,
          schema: { source: 'sdl', file: DEMO_SDL },
        },
      ],
    },
  );
});

afterAll(async () => {
  await h.close();
  await new Promise((r) => upstream.close(r));
});

describe('compressed upstream responses', () => {
  it('passes the compressed body through and still reads GraphQL errors from it', async () => {
    const RUN = { 'x-coverage-run-id': 'gz-1' };
    const ok = await h.gql(
      { query: '{ viewer { id } }' },
      { ...RUN, 'x-test-name': 'ok' },
      '/t/gz/graphql',
    );
    expect(ok.status).toBe(200);
    expect(ok.headers['content-encoding']).toBe('gzip');
    await h.gql(
      { query: 'query broken { viewer { name } }' },
      { ...RUN, 'x-test-name': 'broken gzip' },
      '/t/gz/graphql',
    );
    await h.gql(
      { query: 'query broken { viewer { email } }' },
      { ...RUN, 'x-test-name': 'broken br', 'x-want': 'br' },
      '/t/gz/graphql',
    );
    await h.app.pipeline.idle();

    const ops = await h.api<{ items: { testName: string; hasErrors: boolean | null }[] }>(
      'GET',
      '/api/runs/gz-1/operations',
    );
    const by = Object.fromEntries(ops.json.items.map((o) => [o.testName, o.hasErrors]));
    expect(by).toEqual({ ok: false, 'broken gzip': true, 'broken br': true });

    const { json } = await h.api<{ uncovered: { fields: string[] } }>(
      'GET',
      '/api/runs/gz-1/summary',
    );
    expect(json.uncovered.fields).not.toContain('User.id');
    expect(json.uncovered.fields).toEqual(expect.arrayContaining(['User.name', 'User.email']));
  });
});
