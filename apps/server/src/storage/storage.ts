import type { CoverageData } from '@gqlcov/core';

/** Dialect-independent storage contract. All methods are async so PostgreSQL can implement it as is. */

export interface SnapshotRow {
  id: number;
  target: string;
  hash: string;
  sdl: string;
  source: string;
  createdAt: number;
}

export type RunStatus = 'running' | 'finished';

export interface RunRow {
  id: string;
  target: string;
  schemaSnapshotId: number | null;
  status: RunStatus;
  auto: boolean;
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  buildId: string | null;
  team: string | null;
  testSuite: string | null;
  labels: Record<string, string>;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number;
  requests: {
    total: number;
    valid: number;
    invalid: number;
    introspection: number;
    unresolved: number;
  };
}

export type NewRun = Omit<RunRow, 'requests' | 'finishedAt' | 'status'> & { status?: RunStatus };

export interface RunFilter {
  target?: string | undefined;
  environment?: string | undefined;
  branch?: string | undefined;
  team?: string | undefined;
  testSuite?: string | undefined;
  buildId?: string | undefined;
  status?: RunStatus | undefined;
  /** epoch ms */
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export type OperationStatus = 'valid' | 'invalid' | 'unresolved' | 'no_schema';

export interface OperationLogRow {
  id: number;
  runId: string;
  target: string;
  ts: number;
  operationName: string | null;
  operationType: string | null;
  queryHash: string | null;
  variables: Record<string, unknown> | null;
  headers: Record<string, string> | null;
  testName: string | null;
  testSuite: string | null;
  httpStatus: number | null;
  hasErrors: boolean | null;
  status: OperationStatus;
  errors: string[];
  latencyMs: number | null;
  batchIndex: number | null;
  transport: string | null;
  fields: string[];
}

export type NewOperationLog = Omit<OperationLogRow, 'id'>;

export interface OperationFilter {
  testName?: string | undefined;
  status?: OperationStatus | undefined;
  search?: string | undefined;
  coordinate?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface QueryDocumentRow {
  hash: string;
  query: string;
  normalized: string | null;
}

export interface WriteBatch {
  documents: QueryDocumentRow[];
  logs: NewOperationLog[];
  /** Late updates of already written logs (APQ resolved after the fact). */
  logUpdates: { id: number; patch: Partial<NewOperationLog> }[];
  /** Coverage increments per run. */
  coverage: Map<string, { data: CoverageData; lastActivityAt: number }>;
}

export interface TestRow {
  testKey: string;
  suite: string | null;
  name: string;
  requests: number;
  fields: number;
}

export interface DistinctValues {
  environments: string[];
  branches: string[];
  teams: string[];
  testSuites: string[];
  targets: string[];
}

export interface Storage {
  readonly driver: 'sqlite' | 'postgres';
  /** Run migrations / open connections. */
  init(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;

  saveSnapshot(s: Omit<SnapshotRow, 'id' | 'createdAt'>): Promise<SnapshotRow>;
  getSnapshot(id: number): Promise<SnapshotRow | null>;
  latestSnapshot(target: string): Promise<SnapshotRow | null>;
  listSnapshots(target?: string): Promise<Omit<SnapshotRow, 'sdl'>[]>;

  createRun(run: NewRun): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | null>;
  listRuns(filter: RunFilter): Promise<{ items: RunRow[]; total: number }>;
  finishRun(id: string, at: number): Promise<RunRow | null>;
  /** Most recent running, explicitly created (non-auto) run of a target. */
  activeExplicitRun(target: string): Promise<RunRow | null>;
  /** Running auto runs with lastActivityAt < before. */
  idleAutoRuns(before: number): Promise<RunRow[]>;
  setRunSnapshot(id: string, snapshotId: number): Promise<void>;

  getQueryDocument(hash: string): Promise<QueryDocumentRow | null>;
  /** Returns inserted log ids, aligned with `batch.logs`. */
  write(batch: WriteBatch): Promise<{ logIds: number[] }>;

  loadCoverage(runId: string, opts?: { testKeys?: string[] }): Promise<CoverageData>;
  listTests(runId: string): Promise<TestRow[]>;
  fieldTests(runId: string, coordinate: string): Promise<{ testKey: string; requests: number }[]>;
  listOperations(
    runId: string,
    filter: OperationFilter,
  ): Promise<{ items: OperationLogRow[]; total: number }>;
  getOperation(id: number): Promise<OperationLogRow | null>;
  distinctValues(): Promise<DistinctValues>;
  deleteLogsBefore(ts: number): Promise<number>;
}
