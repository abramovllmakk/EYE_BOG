import type {
  CoverageSummary,
  CoverageReport,
  FieldCoverage,
  FieldHitData,
  SchemaDiff,
  SchemaModel,
  TypeCoverage,
  TypeModel,
  FieldModel,
} from '@gqlcov/core';

export type {
  CoverageSummary,
  CoverageReport,
  FieldCoverage,
  SchemaModel,
  TypeCoverage,
  TypeModel,
  FieldModel,
  SchemaDiff,
};

export interface CompactSummary {
  fields: number;
  types: number;
  operations: number;
  arguments: number;
  enumValues: number;
  inputFields: number;
  edges: number;
}

export interface Run {
  id: string;
  target: string;
  schemaSnapshotId: number | null;
  status: 'running' | 'finished';
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
  summary: CompactSummary | null;
}

export interface Operation {
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
  status: 'valid' | 'invalid' | 'unresolved' | 'no_schema';
  errors: string[];
  latencyMs: number | null;
  batchIndex: number | null;
  transport: string | null;
  fields: string[];
  query?: string | null;
  normalizedQuery?: string | null;
}

export interface FieldDetail {
  coordinate: string;
  typeName: string;
  model: FieldModel;
  coverage: FieldCoverage;
  hit: (Omit<FieldHitData, 'paths'> & { paths: { path: string; requests: number }[] }) | null;
  tests: { testKey: string; requests: number; suite: string | null; name: string }[];
  operations: { items: Operation[]; total: number };
}

export interface TypeDetail {
  type: TypeCoverage | null;
  model: TypeModel;
  fieldTests: Record<string, string[]>;
  referencedBy: string[];
}

export interface Target {
  name: string;
  url: string;
  proxyPath: string;
  schemaSource: string;
  schema: { snapshotId: number; hash: string; source: string; loadedAt: number } | null;
  error: { message: string; hint: string | null } | null;
}

export interface Filters {
  environments: string[];
  branches: string[];
  teams: string[];
  testSuites: string[];
  targets: string[];
}

export interface Compare {
  base: { run: Run; summary: CompactSummary };
  head: { run: Run; summary: CompactSummary };
  delta: CompactSummary;
  newlyCovered: string[];
  lost: string[];
  removedFromSchema: string[];
  schemaDiff: SchemaDiff | null;
}

export interface TimelinePoint {
  runId: string;
  startedAt: number;
  branch: string | null;
  environment: string | null;
  buildId: string | null;
  summary: CompactSummary;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'gqlcov-token';
export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setToken = (t: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* storage unavailable */
  }
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const b = body as { message?: string; hint?: string } | null;
    throw new ApiError(res.status, b?.message ?? res.statusText, b?.hint ?? null);
  }
  return body as T;
}

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface TeamCoverage {
  team: string | null;
  target: string;
  runs: number;
  lastRunAt: number;
  requests: number;
  tests: number;
  summary: CompactSummary;
  uncovered: { fields: number; operations: string[] };
}
