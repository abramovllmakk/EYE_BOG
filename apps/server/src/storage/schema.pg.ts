/**
 * Drizzle schema (PostgreSQL dialect) — 1:1 mirror of schema.sqlite.ts.
 * Timestamps are epoch ms in bigint (mode: number), JSON is stored as text for parity.
 */
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ms = (name: string) => bigint(name, { mode: 'number' });

export const schemaSnapshot = pgTable(
  'schema_snapshot',
  {
    id: serial('id').primaryKey(),
    target: text('target').notNull(),
    hash: text('hash').notNull(),
    sdl: text('sdl').notNull(),
    source: text('source').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [uniqueIndex('schema_snapshot_target_hash').on(t.target, t.hash)],
);

export const run = pgTable(
  'run',
  {
    id: text('id').primaryKey(),
    target: text('target').notNull(),
    schemaSnapshotId: integer('schema_snapshot_id'),
    status: text('status').notNull(),
    auto: integer('auto').notNull().default(0),
    environment: text('environment'),
    branch: text('branch'),
    commitSha: text('commit_sha'),
    buildId: text('build_id'),
    team: text('team'),
    testSuite: text('test_suite'),
    labels: text('labels').notNull().default('{}'),
    startedAt: ms('started_at').notNull(),
    finishedAt: ms('finished_at'),
    lastActivityAt: ms('last_activity_at').notNull(),
    requestsTotal: integer('requests_total').notNull().default(0),
    requestsValid: integer('requests_valid').notNull().default(0),
    requestsInvalid: integer('requests_invalid').notNull().default(0),
    requestsIntrospection: integer('requests_introspection').notNull().default(0),
    requestsUnresolved: integer('requests_unresolved').notNull().default(0),
  },
  (t) => [
    index('run_started_at').on(t.startedAt),
    index('run_branch').on(t.branch),
    index('run_environment').on(t.environment),
  ],
);

export const queryDocument = pgTable('query_document', {
  hash: text('hash').primaryKey(),
  query: text('query').notNull(),
  normalized: text('normalized'),
  createdAt: ms('created_at').notNull(),
});

export const operationLog = pgTable(
  'operation_log',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id').notNull(),
    target: text('target').notNull(),
    ts: ms('ts').notNull(),
    operationName: text('operation_name'),
    operationType: text('operation_type'),
    queryHash: text('query_hash'),
    variables: text('variables'),
    headers: text('headers'),
    testName: text('test_name'),
    testSuite: text('test_suite'),
    httpStatus: integer('http_status'),
    hasErrors: integer('has_errors'),
    status: text('status').notNull(),
    errors: text('errors'),
    latencyMs: real('latency_ms'),
    batchIndex: integer('batch_index'),
    transport: text('transport'),
    fields: text('fields'),
  },
  (t) => [index('operation_log_run').on(t.runId, t.id), index('operation_log_ts').on(t.ts)],
);

const hitColumns = () => ({
  runId: text('run_id').notNull(),
  coordinate: text('coordinate').notNull(),
  requests: integer('requests').notNull(),
  occurrences: integer('occurrences').notNull(),
});

export const fieldHit = pgTable(
  'field_hit',
  {
    ...hitColumns(),
    minDepth: integer('min_depth').notNull(),
    maxDepth: integer('max_depth').notNull(),
    conditionalOnly: integer('conditional_only').notNull(),
    aliases: text('aliases').notNull(),
    fragments: text('fragments').notNull(),
    paths: text('paths').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.coordinate] })],
);

export const fieldTest = pgTable(
  'field_test',
  {
    runId: text('run_id').notNull(),
    coordinate: text('coordinate').notNull(),
    testKey: text('test_key').notNull(),
    requests: integer('requests').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.coordinate, t.testKey] }),
    index('field_test_test').on(t.runId, t.testKey),
  ],
);

export const argHit = pgTable(
  'arg_hit',
  { ...hitColumns(), sources: text('sources').notNull() },
  (t) => [primaryKey({ columns: [t.runId, t.coordinate] })],
);
export const enumValueHit = pgTable('enum_value_hit', { ...hitColumns() }, (t) => [
  primaryKey({ columns: [t.runId, t.coordinate] }),
]);
export const inputFieldHit = pgTable('input_field_hit', { ...hitColumns() }, (t) => [
  primaryKey({ columns: [t.runId, t.coordinate] }),
]);
export const unionMemberHit = pgTable('union_member_hit', { ...hitColumns() }, (t) => [
  primaryKey({ columns: [t.runId, t.coordinate] }),
]);

export const runTest = pgTable(
  'run_test',
  {
    runId: text('run_id').notNull(),
    testKey: text('test_key').notNull(),
    suite: text('suite'),
    name: text('name').notNull(),
    requests: integer('requests').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.testKey] })],
);
