import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { and, count, desc, eq, gte, inArray, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  emptyCoverageData,
  parseTestKey,
  type ArgumentSource,
  type CoverageData,
} from '@gqlcov/core';
import {
  chunks,
  json,
  mergeFieldRow,
  toLog,
  toRun,
  type LogRecord,
  type RunRecord,
} from './common.js';
import * as s from './schema.pg.js';
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

export const PG_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle/pg',
);

/** PostgreSQL implementation of Storage (same tables and semantics as SQLite). */
export class PgStorage implements Storage {
  readonly driver = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly db: NodePgDatabase<typeof s>;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
    this.db = drizzle(this.pool, { schema: s });
  }

  async init(): Promise<void> {
    await migrate(this.db, { migrationsFolder: PG_MIGRATIONS_DIR });
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveSnapshot(x: Omit<SnapshotRow, 'id' | 'createdAt'>): Promise<SnapshotRow> {
    await this.db
      .insert(s.schemaSnapshot)
      .values({ ...x, createdAt: Date.now() })
      .onConflictDoNothing({ target: [s.schemaSnapshot.target, s.schemaSnapshot.hash] });
    const [row] = await this.db
      .select()
      .from(s.schemaSnapshot)
      .where(and(eq(s.schemaSnapshot.target, x.target), eq(s.schemaSnapshot.hash, x.hash)));
    return row!;
  }

  async getSnapshot(id: number): Promise<SnapshotRow | null> {
    const [r] = await this.db.select().from(s.schemaSnapshot).where(eq(s.schemaSnapshot.id, id));
    return r ?? null;
  }

  async latestSnapshot(target: string): Promise<SnapshotRow | null> {
    const [r] = await this.db
      .select()
      .from(s.schemaSnapshot)
      .where(eq(s.schemaSnapshot.target, target))
      .orderBy(desc(s.schemaSnapshot.id))
      .limit(1);
    return r ?? null;
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
      .orderBy(desc(t.id));
  }

  async createRun(r: NewRun): Promise<RunRow> {
    const [row] = await this.db
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
      .returning();
    return toRun(row as RunRecord);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const [r] = await this.db.select().from(s.run).where(eq(s.run.id, id));
    return r ? toRun(r as RunRecord) : null;
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
    const rows = await this.db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.startedAt), desc(t.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0);
    const [{ n }] = (await this.db.select({ n: count() }).from(t).where(where)) as [{ n: number }];
    return { items: rows.map((r) => toRun(r as RunRecord)), total: Number(n) };
  }

  async finishRun(id: string, at: number): Promise<RunRow | null> {
    await this.db
      .update(s.run)
      .set({ status: 'finished', finishedAt: at })
      .where(and(eq(s.run.id, id), eq(s.run.status, 'running')));
    return this.getRun(id);
  }

  async activeExplicitRun(target: string): Promise<RunRow | null> {
    const [r] = await this.db
      .select()
      .from(s.run)
      .where(and(eq(s.run.target, target), eq(s.run.status, 'running'), eq(s.run.auto, 0)))
      .orderBy(desc(s.run.startedAt))
      .limit(1);
    return r ? toRun(r as RunRecord) : null;
  }

  async idleAutoRuns(before: number): Promise<RunRow[]> {
    const rows = await this.db
      .select()
      .from(s.run)
      .where(and(eq(s.run.status, 'running'), eq(s.run.auto, 1), lt(s.run.lastActivityAt, before)));
    return rows.map((r) => toRun(r as RunRecord));
  }

  async setRunSnapshot(id: string, snapshotId: number): Promise<void> {
    await this.db.update(s.run).set({ schemaSnapshotId: snapshotId }).where(eq(s.run.id, id));
  }

  async getQueryDocument(hash: string): Promise<QueryDocumentRow | null> {
    const [r] = await this.db.select().from(s.queryDocument).where(eq(s.queryDocument.hash, hash));
    return r ? { hash: r.hash, query: r.query, normalized: r.normalized } : null;
  }

  async write(batch: WriteBatch): Promise<{ logIds: number[] }> {
    const now = Date.now();
    const logIds: number[] = [];
    await this.db.transaction(async (tx) => {
      for (const d of batch.documents) {
        await tx
          .insert(s.queryDocument)
          .values({ hash: d.hash, query: d.query, normalized: d.normalized, createdAt: now })
          .onConflictDoNothing();
      }
      for (const part of chunks(batch.logs)) {
        const ids = await tx
          .insert(s.operationLog)
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
          .returning({ id: s.operationLog.id });
        logIds.push(...ids.map((r) => r.id));
      }
      for (const u of batch.logUpdates) {
        await tx
          .update(s.operationLog)
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
          .where(eq(s.operationLog.id, u.id));
      }
      for (const [runId, { data, lastActivityAt }] of batch.coverage) {
        const q = data.requests;
        await tx
          .update(s.run)
          .set({
            requestsTotal: sql`${s.run.requestsTotal} + ${q.total}`,
            requestsValid: sql`${s.run.requestsValid} + ${q.valid}`,
            requestsInvalid: sql`${s.run.requestsInvalid} + ${q.invalid}`,
            requestsIntrospection: sql`${s.run.requestsIntrospection} + ${q.introspection}`,
            requestsUnresolved: sql`${s.run.requestsUnresolved} + ${q.unresolved}`,
            lastActivityAt: sql`greatest(${s.run.lastActivityAt}, ${lastActivityAt})`,
          })
          .where(eq(s.run.id, runId));

        for (const part of chunks(Object.keys(data.fields))) {
          const existing = new Map(
            (
              await tx
                .select()
                .from(s.fieldHit)
                .where(and(eq(s.fieldHit.runId, runId), inArray(s.fieldHit.coordinate, part)))
                .for('update')
            ).map((r) => [r.coordinate, r]),
          );
          for (const c of part) {
            const row = mergeFieldRow(existing.get(c), runId, c, data.fields[c]!);
            await tx
              .insert(s.fieldHit)
              .values(row)
              .onConflictDoUpdate({ target: [s.fieldHit.runId, s.fieldHit.coordinate], set: row });
            for (const [testKey, n] of Object.entries(data.fields[c]!.tests)) {
              await tx
                .insert(s.fieldTest)
                .values({ runId, coordinate: c, testKey, requests: n })
                .onConflictDoUpdate({
                  target: [s.fieldTest.runId, s.fieldTest.coordinate, s.fieldTest.testKey],
                  set: { requests: sql`${s.fieldTest.requests} + ${n}` },
                });
            }
          }
        }

        for (const [c, a] of Object.entries(data.arguments)) {
          const [cur] = await tx
            .select()
            .from(s.argHit)
            .where(and(eq(s.argHit.runId, runId), eq(s.argHit.coordinate, c)))
            .for('update');
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
          await tx
            .insert(s.argHit)
            .values(row)
            .onConflictDoUpdate({ target: [s.argHit.runId, s.argHit.coordinate], set: row });
        }

        for (const [table, values] of [
          [s.enumValueHit, data.enumValues],
          [s.inputFieldHit, data.inputFields],
          [s.unionMemberHit, data.unionMembers],
          [s.typeHit, data.types],
        ] as const) {
          for (const [c, h] of Object.entries(values)) {
            await tx
              .insert(table)
              .values({ runId, coordinate: c, requests: h.requests, occurrences: h.occurrences })
              .onConflictDoUpdate({
                target: [table.runId, table.coordinate],
                set: {
                  requests: sql`${table.requests} + ${h.requests}`,
                  occurrences: sql`${table.occurrences} + ${h.occurrences}`,
                },
              });
          }
        }

        for (const [testKey, h] of Object.entries(data.tests)) {
          const { suite, name } = parseTestKey(testKey);
          await tx
            .insert(s.runTest)
            .values({ runId, testKey, suite, name, requests: h.requests })
            .onConflictDoUpdate({
              target: [s.runTest.runId, s.runTest.testKey],
              set: { requests: sql`${s.runTest.requests} + ${h.requests}` },
            });
        }
      }
    });
    return { logIds };
  }

  async loadCoverage(runId: string, opts: { testKeys?: string[] } = {}): Promise<CoverageData> {
    const data = emptyCoverageData();
    const run = await this.getRun(runId);
    if (run) data.requests = { ...run.requests };
    const filterTests = opts.testKeys ? new Set(opts.testKeys) : null;
    const testsByField = new Map<string, Record<string, number>>();
    for (const t of await this.db.select().from(s.fieldTest).where(eq(s.fieldTest.runId, runId))) {
      if (filterTests && !filterTests.has(t.testKey)) continue;
      (testsByField.get(t.coordinate) ?? testsByField.set(t.coordinate, {}).get(t.coordinate)!)[
        t.testKey
      ] = t.requests;
    }
    for (const r of await this.db.select().from(s.fieldHit).where(eq(s.fieldHit.runId, runId))) {
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
      for (const r of await this.db.select().from(s.argHit).where(eq(s.argHit.runId, runId))) {
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
        [s.typeHit, 'types'],
      ] as const) {
        for (const r of await this.db.select().from(table).where(eq(table.runId, runId))) {
          data[key][r.coordinate] = { requests: r.requests, occurrences: r.occurrences };
        }
      }
    }
    for (const r of await this.db.select().from(s.runTest).where(eq(s.runTest.runId, runId))) {
      if (filterTests && !filterTests.has(r.testKey)) continue;
      data.tests[r.testKey] = { requests: r.requests, occurrences: r.requests };
    }
    return data;
  }

  async listTests(runId: string): Promise<TestRow[]> {
    const counts = new Map(
      (
        await this.db
          .select({ testKey: s.fieldTest.testKey, n: count() })
          .from(s.fieldTest)
          .where(eq(s.fieldTest.runId, runId))
          .groupBy(s.fieldTest.testKey)
      ).map((r) => [r.testKey, Number(r.n)]),
    );
    const rows = await this.db
      .select()
      .from(s.runTest)
      .where(eq(s.runTest.runId, runId))
      .orderBy(s.runTest.testKey);
    return rows.map((r) => ({
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
      .orderBy(desc(s.fieldTest.requests), s.fieldTest.testKey);
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
    const rows = await this.db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0);
    const [{ n }] = (await this.db.select({ n: count() }).from(t).where(where)) as [{ n: number }];
    return { items: rows.map((r) => toLog(r as LogRecord)), total: Number(n) };
  }

  async getOperation(id: number): Promise<OperationLogRow | null> {
    const [r] = await this.db.select().from(s.operationLog).where(eq(s.operationLog.id, id));
    return r ? toLog(r as LogRecord) : null;
  }

  async distinctValues(): Promise<DistinctValues> {
    const col = async (c: AnyPgColumn, table: typeof s.run | typeof s.runTest = s.run) =>
      (await this.db.selectDistinct({ v: c }).from(table).orderBy(c))
        .map((r): unknown => r.v)
        .filter((v): v is string => typeof v === 'string' && v !== '');
    return {
      environments: await col(s.run.environment),
      branches: await col(s.run.branch),
      teams: await col(s.run.team),
      testSuites: [
        ...new Set([...(await col(s.run.testSuite)), ...(await col(s.runTest.suite, s.runTest))]),
      ].sort(),
      targets: await col(s.run.target),
    };
  }

  async deleteLogsBefore(ts: number): Promise<number> {
    const res = await this.db.delete(s.operationLog).where(lt(s.operationLog.ts, ts));
    return res.rowCount ?? 0;
  }
}
