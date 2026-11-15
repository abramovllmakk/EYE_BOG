import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';

const ratio = (covered: number, total: number) => ({
  covered,
  total,
  percent: Math.round((covered / total) * 1000) / 10,
});
const summary = {
  run: { id: 'r1', branch: 'main', environment: 'stage', buildId: '7', status: 'finished' },
  summary: {
    fields: ratio(61, 72),
    types: { ...ratio(27, 29), fullyCovered: 10 },
    operations: {
      ...ratio(14, 18),
      query: ratio(9, 9),
      mutation: ratio(4, 7),
      subscription: ratio(1, 2),
    },
    arguments: ratio(23, 29),
    enumValues: ratio(11, 25),
    inputFields: ratio(15, 22),
    edges: ratio(1, 1),
    requests: { total: 20, valid: 19, invalid: 1, introspection: 1, unresolved: 0 },
    tests: 18,
    maxDepth: 7,
  },
  uncovered: { fields: ['Mutation.follow'], operations: ['Mutation.follow'], types: [] },
};

let server: Server;
let url: string;
const seen: { method: string; url: string; body: string; auth?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      const json = (code: number, x: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(x));
      };
      if (req.url === '/api/runs?branch=main&status=finished&limit=5')
        return json(200, { items: [{ id: 'r1' }, { id: 'r0' }] });
      if (req.url === '/api/runs?branch=none&status=finished&limit=5')
        return json(200, { items: [] });
      if (req.url === '/api/runs' && req.method === 'POST')
        return json(201, { id: JSON.parse(body).id ?? 'new-run' });
      if (req.url?.endsWith('/finish')) return json(200, {});
      if (req.url === '/api/runs/missing/summary')
        return json(404, { message: 'Run missing not found' });
      if (req.url?.endsWith('/summary')) return json(200, summary);
      if (req.url?.startsWith('/api/compare'))
        return json(200, {
          delta: { fields: 2.5, types: 0, operations: -1 },
          newlyCovered: ['User.bio'],
          lost: ['User.email'],
          schemaDiff: { added: ['Query.x'], removed: [] },
        });
      if (req.url?.includes('format=csv')) {
        res.writeHead(200, { 'content-type': 'text/csv' });
        return res.end('coordinate,status\nUser.name,covered\n');
      }
      if (req.url?.includes('format=json')) return json(200, { summary: summary.summary });
      if (req.url?.startsWith('/api/schemas/upload'))
        return json(200, { snapshotId: 3, hash: 'abcdef1234567890', types: 12 });
      json(404, { message: 'nope' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function run(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { GQLCOV_SERVER: url, ...env },
  };
  const code = await main(args, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('gqlcov', () => {
  it('prints help', async () => {
    expect((await run(['--help'])).code).toBe(0);
    expect((await run([])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['what'])).err).toMatch(/Unknown command/);
  });

  it('run start prints the run id and sends metadata + token', async () => {
    const r = await run(
      ['run', 'start', '--branch', 'main', '--build', '7', '--env', 'stage', '--team', 'qa'],
      { GQLCOV_TOKEN: 'tok' },
    );
    expect(r).toMatchObject({ code: 0, out: 'new-run' });
    const req = seen.at(-1)!;
    expect(JSON.parse(req.body)).toMatchObject({
      branch: 'main',
      build: '7',
      environment: 'stage',
      team: 'qa',
    });
    expect(req.auth).toBe('Bearer tok');
  });

  it('run finish passes and fails on thresholds', async () => {
    const ok = await run(['run', 'finish', 'r1', '--min-field-coverage', '80']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('fields      84.7% (61/72)');
    const bad = await run([
      'run',
      'finish',
      'r1',
      '--min-field-coverage',
      '90',
      '--min-operation-coverage',
      '80',
    ]);
    expect(bad.code).toBe(3);
    expect(bad.err).toContain('field coverage 84.7% is below the threshold 90%');
    expect(bad.err).toContain('operation coverage 77.8% is below the threshold 80%');
    expect((await run(['run', 'finish', 'r1', '--min-field-coverage', 'abc'])).code).toBe(2);
    expect((await run(['run', 'finish'])).code).toBe(2);
  });

  it('report in markdown (with compare), json and csv', async () => {
    const md = await run(['report', 'r1', '--compare', 'r0']);
    expect(md.out).toContain('| Fields | 84.7% | 61 / 72 | +2.5 |');
    expect(md.out).toContain('Newly covered (1)');
    expect(md.out).toContain('`Mutation.follow`');
    expect(md.out).toContain('Schema changed: +1 / −0');
    expect((await run(['report', 'r1', '--format', 'csv'])).out).toContain('User.name,covered');
    expect(
      JSON.parse((await run(['report', 'r1', '--format', 'json'])).out).summary.fields.covered,
    ).toBe(61);
    expect((await run(['report', 'r1', '--format', 'xml'])).code).toBe(2);
    expect((await run(['report'])).code).toBe(2);
  });

  it('compares with the latest finished run of a branch', async () => {
    const md = await run(['report', 'r1', '--compare-branch', 'main']);
    expect(seen.at(-1)!.url).toBe('/api/compare?base=r0&head=r1');
    expect(md.out).toContain('Δ p.p.');
    const none = await run(['report', 'r1', '--compare-branch', 'none']);
    expect(none.err).toContain('no finished run on branch none');
    expect(none.out).not.toContain('Δ p.p.');
  });

  it('reports API errors and unreachable servers', async () => {
    const r = await run(['report', 'missing']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Run missing not found');
    const down = await run(['report', 'r1', '--server', 'http://127.0.0.1:1']);
    expect(down.err).toMatch(/Cannot reach/);
  });

  it('uploads SDL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gqlcov-cli-'));
    const file = join(dir, 's.graphql');
    writeFileSync(file, 'type Query { a: Int }');
    const r = await run(['schema', 'upload', file, '--target', 'demo']);
    expect(r).toMatchObject({
      code: 0,
      out: 'schema uploaded: snapshot 3, 12 types, hash abcdef123456',
    });
    expect(seen.at(-1)).toMatchObject({
      url: '/api/schemas/upload?target=demo',
      body: 'type Query { a: Int }',
    });
    expect((await run(['schema', 'upload', join(dir, 'missing')])).code).toBe(2);
    expect((await run(['schema', 'upload'])).code).toBe(2);
  });
});
