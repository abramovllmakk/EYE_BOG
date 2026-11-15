import { MAX_ALIASES, MAX_PATHS, type FieldHitData } from '@gqlcov/core';
import type * as s from './schema.sqlite.js';
import type { OperationLogRow, RunRow } from './storage.js';

/** Row mapping shared by the SQLite and PostgreSQL implementations (identical column sets). */
export const json = <T>(v: string | null, fallback: T): T =>
  v == null ? fallback : (JSON.parse(v) as T);
const CHUNK = 400;
export const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

export type RunRecord = typeof s.run.$inferSelect;
export type LogRecord = typeof s.operationLog.$inferSelect;

export function toRun(r: RunRecord): RunRow {
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

export function toLog(r: LogRecord): OperationLogRow {
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

export function mergeFieldRow(
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
