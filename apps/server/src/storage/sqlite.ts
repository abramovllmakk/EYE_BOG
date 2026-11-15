import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, count, desc, eq, gte, inArray, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  emptyCoverageData,
  parseTestKey,
  type ArgumentSource,
  type CoverageData,
  type FieldHitData,
  MAX_ALIASES,
  MAX_PATHS,
} from '@gqlcov/core';
import * as s from './schema.sqlite.js';
import type {
  DistinctValues,
  NewRun,
  OperationFilter,
  OperationLogRow,
  QueryDocumentRow,
  RunFilter,
  RunRow,
  SnapshotRow,
  Storage,
  TestRow,
  WriteBatch,
} from './storage.js';

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle/sqlite',
);

const json = <T>(v: string | null, fallback: T): T => (v == null ? fallback : (JSON.parse(v) as T));
const CHUNK = 400;
const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

type RunRecord = typeof s.run.$inferSelect;
type LogRecord = typeof s.operationLog.$inferSelect;

function toRun(r: RunRecord): RunRow {
  return {
    id: r.id,
    target: r.target,
    schemaSnapshotId: r.schemaSnapshotId,
    status: r.status as RunRow['status'],
    auto: r.auto === 1,
    environment: r.environment,
    branch: r.branch,
    commitSha: r.commitSha,
    buildId: r.buildId,
    team: r.team,
    testSuite: r.testSuite,
    labels: json(r.labels, {}),
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    lastActivityAt: r.lastActivityAt,
    requests: {
      total: r.requestsTotal,
      valid: r.requestsValid,
      invalid: r.requestsInvalid,
      introspection: r.requestsIntrospection,
      unresolved: r.requestsUnresolved,
    },
  };
}

function toLog(r: LogRecord): OperationLogRow {
  return {
    id: r.id,
    runId: r.runId,
    target: r.target,
    ts: r.ts,
    operationName: r.operationName,
    operationType: r.operationType,
    queryHash: r.queryHash,
    variables: json(r.variables, null),
    headers: json(r.headers, null),
    testName: r.testName,
    testSuite: r.testSuite,
    httpStatus: r.httpStatus,
    hasErrors: r.hasErrors == null ? null : r.hasErrors === 1,
    status: r.status as OperationLogRow['status'],
    errors: json(r.errors, []),
    latencyMs: r.latencyMs,
    batchIndex: r.batchIndex,
    transport: r.transport,
    fields: json(r.fields, []),
  };
}

function mergeFieldRow(
  cur: typeof s.fieldHit.$inferSelect | undefined,
  runId: string,
  coordinate: string,
  f: FieldHitData,
): typeof s.fieldHit.$inferInsert {
  if (!cur) {
    return {
      runId,
      coordinate,
      requests: f.requests,
      occurrences: f.occurrences,
      minDepth: f.minDepth,
      maxDepth: f.maxDepth,
      conditionalOnly: f.conditionalOnly ? 1 : 0,
      aliases: JSON.stringify(f.aliases),
      fragments: JSON.stringify(f.fragments),
      paths: JSON.stringify(f.paths),
    };
  }
  const union = (a: string[], b: string[]) =>
    [...new Set([...a, ...b])].slice(0, MAX_ALIASES).sort();
  const paths = json<Record<string, number>>(cur.paths, {});
  for (const [p, n] of Object.entries(f.paths)) {
    if (p in paths) paths[p]! += n;
    else if (Object.keys(paths).length < MAX_PATHS) paths[p] = n;
  }
  return {
    runId,
    coordinate,
    requests: cur.requests + f.requests,
    occurrences: cur.occurrences + f.occurrences,
    minDepth: Math.min(cur.minDepth, f.minDepth),
    maxDepth: Math.max(cur.maxDepth, f.maxDepth),
    conditionalOnly: cur.conditionalOnly === 1 && f.conditionalOnly ? 1 : 0,
    aliases: JSON.stringify(union(json(cur.aliases, []), f.aliases)),
    fragments: JSON.stringify(union(json(cur.fragments, []), f.fragments)),
    paths: JSON.stringify(paths),
  };
}

export class SqliteStorage implements Storage {
  readonly driver = 'sqlite' as const;
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database<typeof s>;

  constructor(url: string, migrationsDir = MIGRATIONS_DIR) {
    if (url !== ':memory:') mkdirSync(dirname(resolve(url)), { recursive: true });
    this.sqlite = new Database(url);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.db = drizzle(this.sqlite, { schema: s });
    migrate(this.db, { migrationsFolder: migrationsDir });
  }

  async ping(): Promise<void> {
    this.sqlite.prepare('select 1').get();
  }

  async close(): Promise<void> {
    this.sqlite.close();
  }

  // --- snapshots -----------------------------------------------------------

  async saveSnapshot(x: Omit<SnapshotRow, 'id' | 'createdAt'>): Promise<SnapshotRow> {
    const existing = this.db
      .select()
      .from(s.schemaSnapshot)
      .where(and(eq(s.schemaSnapshot.target, x.target), eq(s.schemaSnapshot.hash, x.hash)))
      .get();
    if (existing) return existing;
    return this.db
      .insert(s.schemaSnapshot)
      .values({ ...x, createdAt: Date.now() })
      .returning()
      .get();
  }

  async getSnapshot(id: number): Promise<SnapshotRow | null> {
    return this.db.select().from(s.schemaSnapshot).where(eq(s.schemaSnapshot.id, id)).get() ?? null;
  }

  async latestSnapshot(target: string): Promise<SnapshotRow | null> {
    return (
      this.db
        .select()
        .from(s.schemaSnapshot)
        .where(eq(s.schemaSnapshot.target, target))
        .orderBy(desc(s.schemaSnapshot.id))
        .limit(1)
        .get() ?? null
    );
  }

  async listSnapshots(target?: string): Promise<Omit<SnapshotRow, 'sdl'>[]> {
    const t = s.schemaSnapshot;
    return this.db
      .select({
        id: t.id,
        target: t.target,
        hash: t.hash,
        source: t.source,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(target ? eq(t.target, target) : undefined)
      .orderBy(desc(t.id))
      .all();
  }

  // --- runs ----------------------------------------------------------------

  async createRun(r: NewRun): Promise<RunRow> {
    const row = this.db
      .insert(s.run)
      .values({
        id: r.id,
        target: r.target,
        schemaSnapshotId: r.schemaSnapshotId,
        status: r.status ?? 'running',
        auto: r.auto ? 1 : 0,
        environment: r.environment,
        branch: r.branch,
        commitSha: r.commitSha,
        buildId: r.buildId,
        team: r.team,
        testSuite: r.testSuite,
        labels: JSON.stringify(r.labels),
        startedAt: r.startedAt,
        lastActivityAt: r.lastActivityAt,
      })
      .returning()
      .get();
    return toRun(row);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = this.db.select().from(s.run).where(eq(s.run.id, id)).get();
    return r ? toRun(r) : null;
  }

  async listRuns(f: RunFilter): Promise<{ items: RunRow[]; total: number }> {
    const t = s.run;
    const conds: (SQL | undefined)[] = [
      f.target ? eq(t.target, f.target) : undefined,
      f.environment ? eq(t.environment, f.environment) : undefined,
      f.branch ? eq(t.branch, f.branch) : undefined,
      f.team ? eq(t.team, f.team) : undefined,
      f.testSuite ? eq(t.testSuite, f.testSuite) : undefined,
      f.buildId ? eq(t.buildId, f.buildId) : undefined,
      f.status ? eq(t.status, f.status) : undefined,
      f.from !== undefined ? gte(t.startedAt, f.from) : undefined,
      f.to !== undefined ? lte(t.startedAt, f.to) : undefined,
    ];
    const where = and(...conds);
    const items = this.db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.startedAt), desc(t.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0)
      .all()
      .map(toRun);
    const total = this.db.select({ n: count() }).from(t).where(where).get()!.n;
    return { items, total };
  }

  async finishRun(id: string, at: number): Promise<RunRow | null> {
    this.db
      .update(s.run)
      .set({ status: 'finished', finishedAt: at })
      .where(and(eq(s.run.id, id), eq(s.run.status, 'running')))
      .run();
    return this.getRun(id);
  }

  async activeExplicitRun(target: string): Promise<RunRow | null> {
    const r = this.db
      .select()
      .from(s.run)
      .where(and(eq(s.run.target, target), eq(s.run.status, 'running'), eq(s.run.auto, 0)))
      .orderBy(desc(s.run.startedAt))
      .limit(1)
      .get();
    return r ? toRun(r) : null;
  }

  async idleAutoRuns(before: number): Promise<RunRow[]> {
    return this.db
      .select()
      .from(s.run)
      .where(and(eq(s.run.status, 'running'), eq(s.run.auto, 1), lt(s.run.lastActivityAt, before)))
      .all()
      .map(toRun);
  }

  async setRunSnapshot(id: string, snapshotId: number): Promise<void> {
    this.db.update(s.run).set({ schemaSnapshotId: snapshotId }).where(eq(s.run.id, id)).run();
  }

  // --- writes --------------------------------------------------------------

  async getQueryDocument(hash: string): Promise<QueryDocumentRow | null> {
    const r = this.db.select().from(s.queryDocument).where(eq(s.queryDocument.hash, hash)).get();
    return r ? { hash: r.hash, query: r.query, normalized: r.normalized } : null;
  }

  async write(batch: WriteBatch): Promise<{ logIds: number[] }> {
    const now = Date.now();
    const logIds: number[] = [];
    this.db.transaction((tx) => {
      for (const d of batch.documents) {
        tx.insert(s.queryDocument)
          .values({ hash: d.hash, query: d.query, normalized: d.normalized, createdAt: now })
          .onConflictDoNothing()
          .run();
      }
      for (const part of chunks(batch.logs)) {
        tx.insert(s.operationLog)
          .values(
            part.map((l) => ({
              runId: l.runId,
              target: l.target,
              ts: l.ts,
              operationName: l.operationName,
              operationType: l.operationType,
              queryHash: l.queryHash,
              variables: l.variables == null ? null : JSON.stringify(l.variables),
              headers: l.headers == null ? null : JSON.stringify(l.headers),
              testName: l.testName,
              testSuite: l.testSuite,
              httpStatus: l.httpStatus,
              hasErrors: l.hasErrors == null ? null : l.hasErrors ? 1 : 0,
              status: l.status,
              errors: l.errors.length ? JSON.stringify(l.errors) : null,
              latencyMs: l.latencyMs,
              batchIndex: l.batchIndex,
              transport: l.transport,
              fields: l.fields.length ? JSON.stringify(l.fields) : null,
            })),
          )
          .returning({ id: s.operationLog.id })
          .all()
          .forEach((r) => logIds.push(r.id));
      }
      for (const u of batch.logUpdates) {
        tx.update(s.operationLog)
          .set({
            ...(u.patch.status ? { status: u.patch.status } : {}),
            ...(u.patch.errors
              ? { errors: u.patch.errors.length ? JSON.stringify(u.patch.errors) : null }
              : {}),
            ...(u.patch.operationName !== undefined
              ? { operationName: u.patch.operationName }
              : {}),
            ...(u.patch.operationType !== undefined
              ? { operationType: u.patch.operationType }
              : {}),
            ...(u.patch.fields ? { fields: JSON.stringify(u.patch.fields) } : {}),
          })
          .where(eq(s.operationLog.id, u.id))
          .run();
      }
      for (const [runId, { data, lastActivityAt }] of batch.coverage) {
        const q = data.requests;
        tx.update(s.run)
          .set({
            requestsTotal: sql`${s.run.requestsTotal} + ${q.total}`,
            requestsValid: sql`${s.run.requestsValid} + ${q.valid}`,
            requestsInvalid: sql`${s.run.requestsInvalid} + ${q.invalid}`,
            requestsIntrospection: sql`${s.run.requestsIntrospection} + ${q.introspection}`,
            requestsUnresolved: sql`${s.run.requestsUnresolved} + ${q.unresolved}`,
            lastActivityAt: sql`max(${s.run.lastActivityAt}, ${lastActivityAt})`,
          })
          .where(eq(s.run.id, runId))
          .run();

        const coords = Object.keys(data.fields);
        for (const part of chunks(coords)) {
          const existing = new Map(
            tx
              .select()
              .from(s.fieldHit)
              .where(and(eq(s.fieldHit.runId, runId), inArray(s.fieldHit.coordinate, part)))
              .all()
              .map((r) => [r.coordinate, r]),
          );
          for (const c of part) {
            const row = mergeFieldRow(existing.get(c), runId, c, data.fields[c]!);
            tx.insert(s.fieldHit)
              .values(row)
              .onConflictDoUpdate({ target: [s.fieldHit.runId, s.fieldHit.coordinate], set: row })
              .run();
            for (const [testKey, n] of Object.entries(data.fields[c]!.tests)) {
              tx.insert(s.fieldTest)
                .values({ runId, coordinate: c, testKey, requests: n })
                .onConflictDoUpdate({
                  target: [s.fieldTest.runId, s.fieldTest.coordinate, s.fieldTest.testKey],
                  set: { requests: sql`${s.fieldTest.requests} + ${n}` },
                })
                .run();
            }
          }
        }

        for (const [c, a] of Object.entries(data.arguments)) {
          const cur = tx
            .select()
            .from(s.argHit)
            .where(and(eq(s.argHit.runId, runId), eq(s.argHit.coordinate, c)))
            .get();
          const sources = [
            ...new Set([...json<ArgumentSource[]>(cur?.sources ?? null, []), ...a.sources]),
          ].sort();
          const row = {
            runId,
            coordinate: c,
            requests: (cur?.requests ?? 0) + a.requests,
            occurrences: (cur?.occurrences ?? 0) + a.occurrences,
            sources: JSON.stringify(sources),
          };
          tx.insert(s.argHit)
            .values(row)
            .onConflictDoUpdate({ target: [s.argHit.runId, s.argHit.coordinate], set: row })
            .run();
        }

        for (const [table, values] of [
          [s.enumValueHit, data.enumValues],
          [s.inputFieldHit, data.inputFields],
          [s.unionMemberHit, data.unionMembers],
        ] as const) {
          for (const [c, h] of Object.entries(values)) {
            tx.insert(table)
              .values({ runId, coordinate: c, requests: h.requests, occurrences: h.occurrences })
              .onConflictDoUpdate({
                target: [table.runId, table.coordinate],
                set: {
                  requests: sql`${table.requests} + ${h.requests}`,
                  occurrences: sql`${table.occurrences} + ${h.occurrences}`,
                },
              })
              .run();
          }
        }

        for (const [testKey, h] of Object.entries(data.tests)) {
          const { suite, name } = parseTestKey(testKey);
          tx.insert(s.runTest)
            .values({ runId, testKey, suite, name, requests: h.requests })
            .onConflictDoUpdate({
              target: [s.runTest.runId, s.runTest.testKey],
              set: { requests: sql`${s.runTest.requests} + ${h.requests}` },
            })
            .run();
        }
      }
    });
    return { logIds };
  }

  // --- reads ---------------------------------------------------------------

  async loadCoverage(runId: string, opts: { testKeys?: string[] } = {}): Promise<CoverageData> {
    const data = emptyCoverageData();
    const run = await this.getRun(runId);
    if (run) data.requests = { ...run.requests };
    const filterTests = opts.testKeys ? new Set(opts.testKeys) : null;

    const tests = this.db.select().from(s.fieldTest).where(eq(s.fieldTest.runId, runId)).all();
    const testsByField = new Map<string, Record<string, number>>();
    for (const t of tests) {
      if (filterTests && !filterTests.has(t.testKey)) continue;
      (testsByField.get(t.coordinate) ?? testsByField.set(t.coordinate, {}).get(t.coordinate)!)[
        t.testKey
      ] = t.requests;
    }
    for (const r of this.db.select().from(s.fieldHit).where(eq(s.fieldHit.runId, runId)).all()) {
      const fieldTests = testsByField.get(r.coordinate) ?? {};
      if (filterTests && Object.keys(fieldTests).length === 0) continue;
      const requests = filterTests
        ? Object.values(fieldTests).reduce((a, b) => a + b, 0)
        : r.requests;
      data.fields[r.coordinate] = {
        requests,
        occurrences: filterTests ? requests : r.occurrences,
        minDepth: r.minDepth,
        maxDepth: r.maxDepth,
        conditionalOnly: r.conditionalOnly === 1,
        aliases: json(r.aliases, []),
        fragments: json(r.fragments, []),
        paths: json(r.paths, {}),
        tests: fieldTests,
      };
    }
    if (!filterTests) {
      for (const r of this.db.select().from(s.argHit).where(eq(s.argHit.runId, runId)).all()) {
        data.arguments[r.coordinate] = {
          requests: r.requests,
          occurrences: r.occurrences,
          sources: json(r.sources, []),
        };
      }
      for (const [table, key] of [
        [s.enumValueHit, 'enumValues'],
        [s.inputFieldHit, 'inputFields'],
        [s.unionMemberHit, 'unionMembers'],
      ] as const) {
        for (const r of this.db.select().from(table).where(eq(table.runId, runId)).all()) {
          data[key][r.coordinate] = { requests: r.requests, occurrences: r.occurrences };
        }
      }
    }
    for (const r of this.db.select().from(s.runTest).where(eq(s.runTest.runId, runId)).all()) {
      if (filterTests && !filterTests.has(r.testKey)) continue;
      data.tests[r.testKey] = { requests: r.requests, occurrences: r.requests };
    }
    return data;
  }

  async listTests(runId: string): Promise<TestRow[]> {
    const counts = new Map(
      this.db
        .select({ testKey: s.fieldTest.testKey, n: count() })
        .from(s.fieldTest)
        .where(eq(s.fieldTest.runId, runId))
        .groupBy(s.fieldTest.testKey)
        .all()
        .map((r) => [r.testKey, r.n]),
    );
    return this.db
      .select()
      .from(s.runTest)
      .where(eq(s.runTest.runId, runId))
      .orderBy(s.runTest.testKey)
      .all()
      .map((r) => ({
        testKey: r.testKey,
        suite: r.suite,
        name: r.name,
        requests: r.requests,
        fields: counts.get(r.testKey) ?? 0,
      }));
  }

  async fieldTests(
    runId: string,
    coordinate: string,
  ): Promise<{ testKey: string; requests: number }[]> {
    return this.db
      .select({ testKey: s.fieldTest.testKey, requests: s.fieldTest.requests })
      .from(s.fieldTest)
      .where(and(eq(s.fieldTest.runId, runId), eq(s.fieldTest.coordinate, coordinate)))
      .orderBy(desc(s.fieldTest.requests), s.fieldTest.testKey)
      .all();
  }

  async listOperations(
    runId: string,
    f: OperationFilter,
  ): Promise<{ items: OperationLogRow[]; total: number }> {
    const t = s.operationLog;
    const where = and(
      eq(t.runId, runId),
      f.testName ? eq(t.testName, f.testName) : undefined,
      f.status ? eq(t.status, f.status) : undefined,
      f.coordinate ? like(t.fields, `%${JSON.stringify(f.coordinate)}%`) : undefined,
      f.search
        ? or(like(t.operationName, `%${f.search}%`), like(t.testName, `%${f.search}%`))
        : undefined,
    );
    const items = this.db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0)
      .all()
      .map(toLog);
    const total = this.db.select({ n: count() }).from(t).where(where).get()!.n;
    return { items, total };
  }

  async getOperation(id: number): Promise<OperationLogRow | null> {
    const r = this.db.select().from(s.operationLog).where(eq(s.operationLog.id, id)).get();
    return r ? toLog(r) : null;
  }

  async distinctValues(): Promise<DistinctValues> {
    const col = (c: AnySQLiteColumn) =>
      this.db
        .selectDistinct({ v: c })
        .from(s.run)
        .orderBy(c)
        .all()
        .map((r): unknown => r.v)
        .filter((v): v is string => typeof v === 'string' && v !== '');
    return {
      environments: col(s.run.environment),
      branches: col(s.run.branch),
      teams: col(s.run.team),
      testSuites: [
        ...new Set([
          ...col(s.run.testSuite),
          ...this.db
            .selectDistinct({ v: s.runTest.suite })
            .from(s.runTest)
            .all()
            .map((r) => r.v)
            .filter((v): v is string => !!v),
        ]),
      ].sort(),
      targets: col(s.run.target),
    };
  }

  async deleteLogsBefore(ts: number): Promise<number> {
    return this.db.delete(s.operationLog).where(lt(s.operationLog.ts, ts)).run().changes;
  }
}
