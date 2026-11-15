import { request } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const RUN = {
  'x-coverage-run-id': 'cov-1',
  'x-coverage-branch': 'feature/x',
  'x-coverage-env': 'stage',
};

describe('coverage through the proxy', () => {
  beforeAll(async () => {
    await h.gql(
      { query: '{ viewer { id name role } }' },
      { ...RUN, 'x-test-name': 'viewer', 'x-test-suite': 'profile' },
    );
    await h.gql(
      {
        query: 'query($id: ID!) { a: user(id: $id) { name } b: user(id: "u2") { name email } }',
        variables: { id: 'u1' },
      },
      { ...RUN, 'x-test-name': 'users', 'x-test-suite': 'profile' },
    );
    await h.gql(
      [
        {
          query:
            '{ search(text: "g", kinds: [POST, TAG]) { ... on Post { title } ... on Tag { name } } }',
        },
        { query: '{ feed { title ... on Video { durationSec } } }' },
      ],
      { ...RUN, 'x-test-name': 'search', 'x-test-suite': 'discovery' },
    );
    await h.gql(
      {
        query: 'mutation($i: CreatePostInput!) { createPost(input: $i) { id status } }',
        variables: { i: { title: 't', body: 'b', status: 'PUBLISHED', seo: { keywords: ['k'] } } },
      },
      RUN,
    );
    await h.gql({ query: '{ viewer { nope } }' }, RUN);
    await h.gql({ query: '{ __schema { types { name } } }' }, RUN);
    await h.app.pipeline.idle();
  });

  it('records run metadata from headers', async () => {
    const r = await h.api<{
      id: string;
      branch: string;
      environment: string;
      requests: { total: number; valid: number; invalid: number; introspection: number };
    }>('GET', '/api/runs/cov-1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id: 'cov-1',
      branch: 'feature/x',
      environment: 'stage',
      testSuite: null,
    });
    expect(r.json.requests).toMatchObject({ total: 7, valid: 6, invalid: 1, introspection: 1 });
  });

  it('computes field, type, operation, argument, enum and input coverage', async () => {
    const { json } = await h.api<{
      summary: {
        fields: { covered: number };
        operations: { query: { covered: number }; mutation: { covered: number } };
        tests: number;
      };
      uncovered: { fields: string[]; enumValues: string[] };
    }>('GET', '/api/runs/cov-1/summary');
    expect(json.summary.operations.query.covered).toBe(4);
    expect(json.summary.operations.mutation.covered).toBe(1);
    expect(json.summary.tests).toBe(4); // 3 named + unknown
    expect(json.uncovered.fields).toContain('User.bio');
    expect(json.uncovered.fields).not.toContain('User.email');
    expect(json.uncovered.enumValues).toContain('SearchKind.USER');
    expect(json.uncovered.enumValues).not.toContain('SearchKind.TAG');

    const cov = await h.api<{
      types: {
        name: string;
        status: string;
        fields: { name: string; status: string; requests: number; occurrences: number }[];
        values: { name: string; used: boolean }[];
      }[];
    }>('GET', '/api/runs/cov-1/coverage');
    const t = (n: string) => cov.json.types.find((x) => x.name === n)!;
    expect(t('User').status).toBe('partial');
    expect(t('User').fields.find((f) => f.name === 'name')).toMatchObject({
      status: 'covered',
      requests: 2,
      occurrences: 3,
    });
    expect(t('Video').fields.find((f) => f.name === 'title')!.status).toBe('via_interface');
    expect(
      t('SearchResult')
        .values.filter((v) => v.used)
        .map((v) => v.name)
        .sort(),
    ).toEqual(['Post', 'Tag']);
    expect(t('SeoInput').values.find((v) => v.name === 'keywords')!.used).toBe(true);
    expect(t('Comment').status).toBe('uncovered');

    const only = await h.api<{ types: { name: string; fields: { status: string }[] }[] }>(
      'GET',
      '/api/runs/cov-1/coverage?status=uncovered&kind=OBJECT',
    );
    expect(only.json.types.every((x) => x.fields.every((f) => f.status !== 'covered'))).toBe(true);
    const search = await h.api<{ types: { name: string }[] }>(
      'GET',
      '/api/runs/cov-1/coverage?search=durationSec',
    );
    expect(search.json.types.map((x) => x.name)).toEqual(['Video']);
  });

  it('serves field detail with tests, paths, aliases and sample operations', async () => {
    const { json } = await h.api<{
      hit: { aliases: string[]; paths: { path: string }[] };
      tests: { name: string; suite: string }[];
      operations: { items: { id: number }[] };
    }>('GET', '/api/runs/cov-1/fields/User.name');
    expect(json.hit.aliases).toEqual([]);
    const user = await h.api<{ hit: { aliases: string[] } }>(
      'GET',
      '/api/runs/cov-1/fields/Query.user',
    );
    expect(user.json.hit.aliases).toEqual(['a', 'b']);
    expect(json.hit.paths.map((p) => p.path)).toEqual(['query.user.name', 'query.viewer.name']);
    expect(json.tests.map((t) => t.name).sort()).toEqual(['users', 'viewer']);
    expect(json.operations.items.length).toBe(2);
    const op = await h.api<{
      query: string;
      testName: string;
      fields: string[];
      variables: Record<string, unknown>;
    }>('GET', `/api/operations/${json.operations.items[0]!.id}`);
    expect(op.json.query).toContain('user(id: $id)');
    expect(op.json.testName).toBe('users');
    expect(op.json.variables).toEqual({ id: '<string>' });
    expect(op.json.fields).toContain('Query.user');
  });

  it('serves type detail, tests, groups and drill-down filters', async () => {
    const type = await h.api<{
      model: { possibleTypes: string[] };
      fieldTests: Record<string, string[]>;
    }>('GET', '/api/runs/cov-1/types/User');
    expect(type.json.fieldTests['role']).toEqual(['profile::viewer']);
    const tests = await h.api<{ testKey: string; fields: number }[]>(
      'GET',
      '/api/runs/cov-1/tests',
    );
    expect(tests.json.map((t) => t.testKey)).toEqual([
      'discovery::search',
      'profile::users',
      'profile::viewer',
      'unknown',
    ]);
    const groups = await h.api<{ suite: string; tests: number }[]>('GET', '/api/runs/cov-1/groups');
    expect(groups.json.map((g) => [g.suite, g.tests])).toEqual([
      ['discovery', 1],
      ['profile', 2],
    ]);
    const invalid = await h.api<{ items: { errors: string[] }[] }>(
      'GET',
      '/api/runs/cov-1/operations?status=invalid',
    );
    expect(invalid.json.items[0]!.errors[0]).toMatch(/Cannot query field "nope"/);
    const batch = await h.api<{ items: { batchIndex: number | null; transport: string }[] }>(
      'GET',
      '/api/runs/cov-1/operations?test=search',
    );
    expect(batch.json.items.map((i) => i.batchIndex).sort()).toEqual([0, 1]);
  });

  it('exports CSV and JSON', async () => {
    const csv = await request(h.adminUrl + '/api/runs/cov-1/export?format=csv');
    const text = await csv.body.text();
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(text.split('\n')[0]).toBe(
      'coordinate,type,kind,field,status,requests,occurrences,tests,max_depth',
    );
    expect(text).toContain('User.name,User,OBJECT,name,covered,2,3,2,2');
    const json = await h.api<{ summary: unknown }>('GET', '/api/runs/cov-1/export?format=json');
    expect(json.json.summary).toBeTruthy();
  });
});

describe('run resolution', () => {
  it('path prefix run id', async () => {
    await h.gql({ query: '{ tags { name } }' }, {}, '/proxy/path-run/graphql');
    await h.app.pipeline.idle();
    expect(
      (await h.api<{ requests: { total: number } }>('GET', '/api/runs/path-run')).json.requests
        .total,
    ).toBe(1);
  });

  it('explicit lifecycle: start → plain requests are attributed → finish with summary', async () => {
    const start = await h.api<{ id: string }>('POST', '/api/runs', { branch: 'main', build: '42' });
    expect(start.status).toBe(201);
    await h.gql({ query: '{ viewer { id } }' });
    await h.gql({ query: '{ tags { name } }' });
    const fin = await h.api<{
      run: { status: string; requests: { total: number } };
      summary: { fields: { covered: number } };
    }>('POST', `/api/runs/${start.json.id}/finish`);
    expect(fin.json.run.status).toBe('finished');
    expect(fin.json.run.requests.total).toBe(2);
    expect(fin.json.summary.fields.covered).toBe(4);
    const list = await h.api<{
      items: { id: string; summary: { fields: number } }[];
      total: number;
    }>('GET', '/api/runs?branch=main&build=42');
    expect(list.json.items.map((r) => r.id)).toEqual([start.json.id]);
    expect(list.json.items[0]!.summary.fields).toBeGreaterThan(0);
  });

  it('automatic run per metadata, closed after idle timeout', async () => {
    await h.gql({ query: '{ viewer { id } }' }, { 'x-coverage-env': 'auto-env' });
    await h.app.pipeline.idle();
    const runs = await h.api<{
      items: { id: string; status: string; labels: Record<string, string> }[];
    }>('GET', '/api/runs?environment=auto-env');
    expect(runs.json.items).toHaveLength(1);
    expect(runs.json.items[0]!.labels.auto).toBe('true');
    const closed = await h.app.runs.closeIdle(Date.now() + 3600_000);
    expect(closed).toContain(runs.json.items[0]!.id);
    await h.gql({ query: '{ viewer { id } }' }, { 'x-coverage-env': 'auto-env' });
    await h.app.pipeline.idle();
    expect(
      (await h.api<{ items: unknown[] }>('GET', '/api/runs?environment=auto-env')).json.items,
    ).toHaveLength(2);
  });

  it('compares two runs', async () => {
    await h.gql({ query: '{ viewer { id name } }' }, { 'x-coverage-run-id': 'cmp-a' });
    await h.gql({ query: '{ viewer { id bio } }' }, { 'x-coverage-run-id': 'cmp-b' });
    await h.app.pipeline.idle();
    const { json } = await h.api<{
      newlyCovered: string[];
      lost: string[];
      schemaDiff: unknown;
      delta: { fields: number };
    }>('GET', '/api/compare?base=cmp-a&head=cmp-b');
    expect(json.newlyCovered).toEqual(['User.bio']);
    expect(json.lost).toEqual(['User.name']);
    expect(json.schemaDiff).toBeNull();
    expect(json.delta.fields).toBe(0);
  });

  it('timeline and filters', async () => {
    const tl = await h.api<{ runId: string }[]>('GET', '/api/timeline?limit=100');
    expect(tl.json.length).toBeGreaterThan(3);
    const f = await h.api<{ branches: string[]; environments: string[] }>('GET', '/api/filters');
    expect(f.json.branches).toContain('feature/x');
    expect(f.json.environments).toContain('stage');
  });
});

describe('APQ', () => {
  it('counts hash-only requests as unresolved and resolves them once the mapping appears', async () => {
    const query = '{ tags { name posts { id } } }';
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(query).digest('hex');
    const ext = { persistedQuery: { version: 1, sha256Hash: hash } };
    // Backend (yoga without APQ plugin) answers with an error to a hash-only request; it is kept unresolved.
    await h.gql({ extensions: ext }, { 'x-coverage-run-id': 'apq' });
    await h.app.pipeline.idle();
    let run = await h.api<{ requests: { unresolved: number; valid: number } }>(
      'GET',
      '/api/runs/apq',
    );
    expect(run.json.requests).toMatchObject({ unresolved: 1, valid: 0 });
    // Register the mapping, then a hash-only request is resolved immediately.
    await h.gql({ query, extensions: ext }, { 'x-coverage-run-id': 'apq' });
    await h.app.pipeline.idle();
    await h.app.pipeline.enqueue({
      target: 'demo',
      ts: Date.now(),
      transport: 'post',
      method: 'POST',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ extensions: ext })),
      headers: {},
      meta: { runId: 'apq' },
      test: {},
      httpStatus: 200,
      latencyMs: 1,
    });
    await h.app.pipeline.idle();
    run = await h.api('GET', '/api/runs/apq');
    expect(run.json.requests).toMatchObject({ unresolved: 1, valid: 2 });
    const field = await h.api<{ coverage: { requests: number } }>(
      'GET',
      '/api/runs/apq/fields/Tag.posts',
    );
    expect(field.json.coverage.requests).toBe(2);
  });

  it('resolves an executed hash-only request later', async () => {
    const query = '{ users { id name } }';
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(query).digest('hex');
    const job = (body: unknown) => ({
      target: 'demo',
      ts: Date.now(),
      transport: 'post' as const,
      method: 'POST',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(body)),
      headers: {},
      meta: { runId: 'apq-late' },
      test: {},
      httpStatus: 200,
      responseBody: Buffer.from('{"data":{"users":[]}}'),
      latencyMs: 1,
    });
    h.app.pipeline.enqueue(
      job({ extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    );
    await h.app.pipeline.idle();
    expect(
      (await h.api<{ requests: { unresolved: number } }>('GET', '/api/runs/apq-late')).json.requests
        .unresolved,
    ).toBe(1);
    h.app.pipeline.enqueue(job({ query }));
    await h.app.pipeline.idle();
    const run = await h.api<{ requests: { unresolved: number; valid: number; total: number } }>(
      'GET',
      '/api/runs/apq-late',
    );
    expect(run.json.requests).toMatchObject({ unresolved: 0, valid: 2, total: 2 });
    const ops = await h.api<{ items: { status: string }[] }>(
      'GET',
      '/api/runs/apq-late/operations',
    );
    expect(ops.json.items.map((o) => o.status)).toEqual(['valid', 'valid']);
  });
});

describe('schemas', () => {
  it('lists snapshots, uploads SDL, versions by hash and diffs', async () => {
    const list = await h.api<{ id: number; target: string; current: boolean }[]>(
      'GET',
      '/api/schemas',
    );
    expect(
      list.json
        .filter((s) => s.current)
        .map((s) => s.target)
        .sort(),
    ).toEqual(['demo', 'echo']);
    const bad = await h.api<{ error: string }>('POST', '/api/schemas', {
      target: 'echo',
      sdl: 'type Query { a: Nope }',
    });
    expect(bad.status).toBe(422);
    const up = await h.api<{ snapshotId: number }>('POST', '/api/schemas', {
      target: 'echo',
      sdl: 'type Query { a: Int b: String }',
    });
    expect(up.status).toBe(200);
    const again = await h.api<{ snapshotId: number }>('POST', '/api/schemas', {
      target: 'echo',
      sdl: 'type Query { b: String a: Int }',
    });
    expect(again.json.snapshotId).toBe(up.json.snapshotId);
    const raw = await request(h.adminUrl + '/api/schemas/upload?target=echo', {
      method: 'POST',
      headers: { 'content-type': 'application/graphql' },
      body: 'type Query { a: Int c: Boolean }',
    });
    const rawJson = (await raw.body.json()) as { snapshotId: number };
    const diff = await h.api<{ added: string[]; removed: string[] }>(
      'GET',
      `/api/schemas/diff?base=${up.json.snapshotId}&head=${rawJson.snapshotId}`,
    );
    expect(diff.json).toMatchObject({ added: ['Query.c'], removed: ['Query.b'] });
    const refresh = await h.api<{ snapshotId: number }>('POST', '/api/schemas/refresh', {
      target: 'demo',
    });
    expect(refresh.status).toBe(200);
  });

  it('openapi, health, readiness and metrics', async () => {
    const spec = await h.api<{ paths: Record<string, unknown> }>('GET', '/docs/json');
    expect(Object.keys(spec.json.paths)).toEqual(
      expect.arrayContaining(['/api/runs', '/api/runs/{id}/coverage', '/api/compare']),
    );
    expect((await h.api('GET', '/readyz')).status).toBe(200);
    const m = await request(h.adminUrl + '/metrics');
    const text = await m.body.text();
    expect(text).toContain('gqlcov_proxy_requests_total');
    expect(text).toContain('gqlcov_proxy_overhead_seconds_bucket');
    expect(text).toContain('gqlcov_analysis_queue_length');
  });

  it('404 for unknown run', async () => {
    expect((await h.api('GET', '/api/runs/nope/summary')).status).toBe(404);
  });
});

describe('federation supergraph', () => {
  it('keeps @join__ ownership through storage and reports coverage per subgraph', async () => {
    const { readFileSync } = await import('node:fs');
    const sdl = readFileSync(
      new URL('../../../packages/core/test/fixtures/supergraph.graphql', import.meta.url),
      'utf8',
    );
    const up = await h.api<{ snapshotId: number }>('POST', '/api/schemas', { target: 'echo', sdl });
    expect(up.status).toBe(200);
    // Reload from storage (not the in-memory object) to prove the directives survive.
    const snap = await h.api<{ model: { services: string[] } }>(
      'GET',
      `/api/schemas/${up.json.snapshotId}`,
    );
    expect(snap.json.model.services).toEqual(['accounts', 'legacy', 'products', 'reviews']);
    await h.gql(
      { query: '{ me { id name } topProducts { upc } }' },
      { 'x-coverage-run-id': 'fed' },
      '/t/echo/graphql',
    );
    await h.app.pipeline.idle();
    const s = await h.api<{
      summary: { services: { service: string; fields: { covered: number; total: number } }[] };
    }>('GET', '/api/runs/fed/summary');
    expect(s.json.summary.services.find((x) => x.service === 'accounts')!.fields).toMatchObject({
      covered: 3,
      total: 3,
    });
    expect(s.json.summary.services.find((x) => x.service === 'products')!.fields).toMatchObject({
      covered: 2,
      total: 4,
    });
  });
});
