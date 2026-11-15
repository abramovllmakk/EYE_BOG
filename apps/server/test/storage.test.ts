import { emptyCoverageData, type CoverageData } from '@gqlcov/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStorage } from '../src/storage/pg.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import type { NewOperationLog, Storage } from '../src/storage/storage.js';

/** Same contract for every driver. PostgreSQL runs when PG_URL is set (see docker-compose `postgres` profile). */
const drivers: [string, () => Storage][] = [['sqlite', () => new SqliteStorage(':memory:')]];
if (process.env.PG_URL) drivers.push(['postgres', () => new PgStorage(process.env.PG_URL!)]);

const log = (runId: string, over: Partial<NewOperationLog> = {}): NewOperationLog => ({
  runId,
  target: 't',
  ts: Date.now(),
  operationName: 'Op',
  operationType: 'query',
  queryHash: 'h1',
  variables: { id: '<string>' },
  headers: { authorization: '***' },
  testName: 'login',
  testSuite: 'auth',
  httpStatus: 200,
  hasErrors: false,
  status: 'valid',
  errors: [],
  latencyMs: 1.5,
  batchIndex: null,
  transport: 'post',
  fields: ['Query.me', 'User.name'],
  ...over,
});

function coverage(): CoverageData {
  const d = emptyCoverageData();
  d.requests = { total: 2, valid: 2, invalid: 0, introspection: 0, unresolved: 0 };
  d.fields['User.name'] = {
    requests: 2,
    occurrences: 3,
    minDepth: 2,
    maxDepth: 3,
    conditionalOnly: false,
    aliases: ['n'],
    fragments: [],
    paths: { 'query.me.name': 2 },
    tests: { 'auth::login': 2 },
  };
  d.arguments['Query.user(id:)'] = { requests: 1, occurrences: 1, sources: ['variable'] };
  d.enumValues['Role.ADMIN'] = { requests: 1, occurrences: 1 };
  d.inputFields['F.a'] = { requests: 1, occurrences: 2 };
  d.unionMembers['U.A'] = { requests: 1, occurrences: 1 };
  d.tests['auth::login'] = { requests: 2, occurrences: 2 };
  d.types['User'] = { requests: 2, occurrences: 3 };
  return d;
}

for (const [name, make] of drivers) {
  describe(`storage contract: ${name}`, () => {
    let st: Storage;
    const run = `run-${name}-${Date.now()}`;
    beforeAll(async () => {
      st = make();
      await st.init();
    });
    afterAll(async () => {
      await st.close();
    });

    it('snapshots are versioned by (target, hash)', async () => {
      const a = await st.saveSnapshot({
        target: `t-${run}`,
        hash: 'x',
        sdl: 'type Query { a: Int }',
        source: 'upload',
      });
      const b = await st.saveSnapshot({
        target: `t-${run}`,
        hash: 'x',
        sdl: 'ignored',
        source: 'upload',
      });
      expect(b.id).toBe(a.id);
      expect((await st.latestSnapshot(`t-${run}`))!.id).toBe(a.id);
      expect((await st.getSnapshot(a.id))!.sdl).toBe('type Query { a: Int }');
      expect((await st.listSnapshots(`t-${run}`)).map((x) => x.id)).toEqual([a.id]);
    });

    it('runs: create, list with filters, explicit/auto lookup, finish', async () => {
      const now = Date.now();
      const base = {
        target: 't',
        schemaSnapshotId: null,
        environment: 'stage',
        branch: `b-${run}`,
        commitSha: 'c',
        buildId: '1',
        team: 'qa',
        testSuite: null,
        labels: { k: 'v' },
        startedAt: now,
        lastActivityAt: now,
      };
      await st.createRun({ ...base, id: run, auto: false });
      await st.createRun({ ...base, id: `${run}-auto`, auto: true, lastActivityAt: now - 10_000 });
      const list = await st.listRuns({
        branch: `b-${run}`,
        team: 'qa',
        from: now - 1,
        to: now + 1,
      });
      expect(list.total).toBe(2);
      expect((await st.activeExplicitRun('t'))?.id).toBeDefined();
      expect((await st.idleAutoRuns(now - 1)).map((r) => r.id)).toContain(`${run}-auto`);
      const r = await st.getRun(run);
      expect(r).toMatchObject({ labels: { k: 'v' }, auto: false, status: 'running' });
    });

    it('batched writes merge coverage and return log ids', async () => {
      const { logIds } = await st.write({
        documents: [
          { hash: 'h1', query: '{ me { name } }', normalized: '{\n  me {\n    name\n  }\n}' },
        ],
        logs: [log(run), log(run, { status: 'unresolved', fields: [] })],
        logUpdates: [],
        coverage: new Map([[run, { data: coverage(), lastActivityAt: Date.now() }]]),
      });
      expect(logIds).toHaveLength(2);
      const second = coverage();
      second.fields['User.name']!.aliases = ['m'];
      second.fields['User.name']!.paths = { 'query.user.name': 1 };
      second.arguments['Query.user(id:)']!.sources = ['literal'];
      await st.write({
        documents: [{ hash: 'h1', query: 'dup', normalized: null }],
        logs: [],
        logUpdates: [{ id: logIds[1]!, patch: { status: 'valid', fields: ['Query.me'] } }],
        coverage: new Map([[run, { data: second, lastActivityAt: Date.now() }]]),
      });

      const d = await st.loadCoverage(run);
      expect(d.requests.total).toBe(4);
      expect(d.fields['User.name']).toMatchObject({
        requests: 4,
        occurrences: 6,
        aliases: ['m', 'n'],
        paths: { 'query.me.name': 2, 'query.user.name': 1 },
        tests: { 'auth::login': 4 },
      });
      expect(d.arguments['Query.user(id:)']!.sources).toEqual(['literal', 'variable']);
      expect(d.enumValues['Role.ADMIN']).toEqual({ requests: 2, occurrences: 2 });
      expect(d.inputFields['F.a']).toEqual({ requests: 2, occurrences: 4 });
      expect(d.types['User']).toEqual({ requests: 4, occurrences: 6 });
      expect((await st.getQueryDocument('h1'))!.query).toBe('{ me { name } }');
      expect((await st.getOperation(logIds[1]!))!).toMatchObject({
        status: 'valid',
        fields: ['Query.me'],
      });
      const filtered = await st.loadCoverage(run, { testKeys: ['nobody'] });
      expect(Object.keys(filtered.fields)).toEqual([]);
    });

    it('reads tests, field tests, operations and distinct values', async () => {
      expect(await st.listTests(run)).toEqual([
        { testKey: 'auth::login', suite: 'auth', name: 'login', requests: 4, fields: 1 },
      ]);
      expect(await st.fieldTests(run, 'User.name')).toEqual([
        { testKey: 'auth::login', requests: 4 },
      ]);
      const ops = await st.listOperations(run, {
        coordinate: 'User.name',
        search: 'Op',
        testName: 'login',
        status: 'valid',
      });
      expect(ops.total).toBe(1);
      expect(ops.items[0]).toMatchObject({
        hasErrors: false,
        variables: { id: '<string>' },
        headers: { authorization: '***' },
      });
      const dv = await st.distinctValues();
      expect(dv.branches).toContain(`b-${run}`);
      expect(dv.testSuites).toContain('auth');
    });

    it('finishes runs and applies retention', async () => {
      expect((await st.finishRun(run, Date.now()))!.status).toBe('finished');
      expect(await st.activeExplicitRun('t')).toBeNull();
      expect(await st.deleteLogsBefore(Date.now() + 1000)).toBeGreaterThanOrEqual(2);
      await st.ping();
    });
  });
}

describe.runIf(!!process.env.PG_URL)('whole app on PostgreSQL', () => {
  it('proxies, analyses and reports coverage with storage.driver=postgres', async () => {
    const { startHarness } = await import('./helpers.js');
    const h = await startHarness({ storage: { driver: 'postgres', url: process.env.PG_URL } });
    try {
      const runId = `pg-app-${Date.now()}`;
      const res = await h.gql(
        { query: '{ viewer { id name } }' },
        { 'x-coverage-run-id': runId, 'x-test-name': 'pg' },
      );
      expect(res.status).toBe(200);
      await h.app.pipeline.idle();
      const s = await h.api<{
        summary: { fields: { covered: number } };
        run: { requests: { total: number } };
      }>('GET', `/api/runs/${runId}/summary`);
      expect(s.json.run.requests.total).toBe(1);
      expect(s.json.summary.fields.covered).toBe(3);
      expect(h.app.storage.driver).toBe('postgres');
    } finally {
      await h.close();
    }
  });
});
