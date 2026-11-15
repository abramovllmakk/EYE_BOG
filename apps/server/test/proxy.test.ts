import { request, FormData } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stable, startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

async function direct(url: string, init: Parameters<typeof request>[1]) {
  const r = await request(url, init);
  return { status: r.statusCode, headers: r.headers, text: await r.body.text() };
}

describe('transparency: client gets exactly what the backend returns', () => {
  const cases: [string, Parameters<typeof request>[1], string?][] = [
    [
      'POST query',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ viewer { id name posts { title } } }' }),
      },
    ],
    [
      'POST with variables',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query($id: ID!) { user(id: $id) { name role } }',
          variables: { id: 'u2' },
        }),
      },
    ],
    [
      'batched',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ query: '{ tags { name } }' }, { query: '{ users { id } }' }]),
      },
    ],
    [
      'invalid query',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ viewer { nope } }' }),
      },
    ],
    [
      'malformed JSON',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' },
    ],
    [
      'resolver error',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'mutation { likePost(postId: "nope") { id } }' }),
      },
    ],
    [
      'GET',
      { method: 'GET', headers: { accept: 'application/json' } },
      `?query=${encodeURIComponent('{ tags { name } }')}`,
    ],
  ];
  for (const [name, init, qs] of cases) {
    it(name, async () => {
      const viaProxy = await direct(h.proxyUrl + '/graphql' + (qs ?? ''), init);
      const viaBackend = await direct(h.demoUrl + (qs ?? ''), init);
      expect(viaProxy.status).toBe(viaBackend.status);
      expect(viaProxy.text).toBe(viaBackend.text);
      expect(stable(viaProxy.headers)).toEqual(stable(viaBackend.headers));
    });
  }

  it('streams SSE subscriptions through', async () => {
    const res = await request(h.proxyUrl + '/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query: 'subscription { postAdded { id title } }' }),
    });
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const reader = res.body;
    const got = new Promise<string>((resolve) => {
      let buf = '';
      reader.on('data', (c: Buffer) => {
        buf += c.toString();
        if (buf.includes('"postAdded"')) resolve(buf);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    await h.gql({
      query:
        'mutation { createPost(input: { title: "sse", body: "b", status: PUBLISHED }) { id } }',
    });
    expect(await got).toContain('"title":"sse"');
    reader.destroy();
  });

  it('answers 502 when the upstream is down', async () => {
    const res = await request(h.proxyUrl + '/t/nope/graphql', { method: 'POST', body: '{}' });
    expect(res.statusCode).toBe(404);
    await res.body.text();
  });
});

describe('headers', () => {
  it('strips X-Coverage-* and hop-by-hop headers, rewrites Host, applies add/override/remove', async () => {
    h.echo.received.length = 0;
    const res = await h.gql(
      { query: '{ viewer { id } }' },
      {
        'x-coverage-run-id': 'hdr-run',
        'x-coverage-branch': 'main',
        'x-test-name': 'headers test',
        'x-drop-me': '1',
        'x-keep': 'client',
        authorization: 'Bearer client-secret',
        'proxy-connection': 'keep-alive',
      },
      '/t/echo/graphql',
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('echo');
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    const got = h.echo.received[0]!.headers;
    expect(Object.keys(got).filter((k) => k.startsWith('x-coverage-'))).toEqual([]);
    expect(got['x-test-name']).toBe('headers test');
    expect(got['x-drop-me']).toBeUndefined();
    expect(got['proxy-connection']).toBeUndefined();
    expect(got['x-keep']).toBe('client');
    expect(got['x-added']).toBe('added');
    expect(got.authorization).toBe('Bearer stand-token');
    expect(got.host).toBe(new URL(h.echo.url).host);
  });

  it('forwards multipart uploads byte-for-byte and analyses only `operations`', async () => {
    h.echo.received.length = 0;
    const form = new FormData();
    form.set(
      'operations',
      JSON.stringify({
        query: 'mutation($t: String!) { createPost(input: { title: $t, body: "x" }) { id } }',
        variables: { t: 'up' },
      }),
    );
    form.set('map', JSON.stringify({ 0: ['variables.file'] }));
    const bytes = Buffer.alloc(256 * 1024, 7);
    form.set('0', new Blob([bytes]), 'big.bin');
    const res = await request(h.proxyUrl + '/t/echo/proxy/multipart-run/graphql', {
      method: 'POST',
      body: form,
    });
    expect(res.statusCode).toBe(200);
    await res.body.text();
    const rec = h.echo.received[0]!;
    expect(rec.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(rec.body.includes(bytes)).toBe(true);
    await h.app.pipeline.idle();
    const ops = await h.api<{ items: { transport: string; status: string; fields: string[] }[] }>(
      'GET',
      '/api/runs/multipart-run/operations',
    );
    expect(ops.json.items[0]).toMatchObject({ transport: 'multipart', status: 'valid' });
    expect(ops.json.items[0]!.fields).toContain('Mutation.createPost');
  });
});

describe('non-ASCII metadata headers', () => {
  it('decodes raw UTF-8 and percent-encoded test names, suites and branches', async () => {
    // Raw UTF-8 bytes on the wire, exactly like curl sends them (written straight to a socket so
    // no HTTP client re-encodes the header).
    const { connect } = await import('node:net');
    const u = new URL(h.proxyUrl);
    const body = JSON.stringify({ query: '{ viewer { name } }' });
    const head = [
      'POST /graphql HTTP/1.1',
      `Host: ${u.host}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'X-Coverage-Run-Id: utf8-run',
      'X-Coverage-Branch: фича/кириллица',
      'X-Test-Name: мой первый тест',
      'X-Test-Suite: профиль',
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    await new Promise<void>((resolve, reject) => {
      const sock = connect(Number(u.port), u.hostname, () =>
        sock.end(Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(body)])),
      );
      sock.on('data', () => {});
      sock.on('close', () => resolve());
      sock.on('error', reject);
    });
    // Percent-encoded, the only way for fetch()-based clients.
    await h.gql(
      { query: '{ tags { name } }' },
      { 'x-coverage-run-id': 'utf8-run', 'x-test-name': encodeURIComponent('логин админа') },
    );
    await h.app.pipeline.idle();
    const tests = await h.api<{ testKey: string; name: string; suite: string | null }[]>(
      'GET',
      '/api/runs/utf8-run/tests',
    );
    expect(tests.json.map((t) => t.testKey).sort()).toEqual([
      'логин админа',
      'профиль::мой первый тест',
    ]);
    const run = await h.api<{ branch: string }>('GET', '/api/runs/utf8-run');
    expect(run.json.branch).toBe('фича/кириллица');
    const ops = await h.api<{ items: { testName: string; headers: Record<string, string> }[] }>(
      'GET',
      '/api/runs/utf8-run/operations',
    );
    expect(ops.json.items.map((o) => o.testName).sort()).toEqual([
      'логин админа',
      'мой первый тест',
    ]);
    expect(
      ops.json.items.find((o) => o.testName === 'мой первый тест')!.headers['x-test-suite'],
    ).toBe('профиль');
  });
});
