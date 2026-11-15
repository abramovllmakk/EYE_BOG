/**
 * Coverage model.
 *
 * DEFINITIONS (mirrored in README "Coverage metrics"):
 *  - A field `Type.field` is COVERED when it was selected at least once in a VALID request.
 *    `requests` = number of requests in which it appeared; `occurrences` = total selections.
 *  - Introspection (`__schema`, `__type`) and `__typename` never count.
 *  - Object / Interface type: COVERED = all fields covered, PARTIAL = some, UNCOVERED = none.
 *    percent = covered fields / all fields.
 *  - A field of an object type that is NOT selected directly, but whose interface field
 *    `Interface.field` is covered, has status VIA_INTERFACE. It counts as covered only when
 *    `propagateInterfaceCoverage` is enabled.
 *  - Union: share of members selected through a fragment with that member (or an interface it
 *    implements) as type condition.
 *  - Enum: share of values used in arguments or input objects (literals or variables).
 *  - Input object: share of its fields that were explicitly passed.
 *  - Argument `Type.field(arg:)`: used or not.
 *  - Operations: share of root fields of Query / Mutation / Subscription that were called.
 *  - Edges (relations): fields whose named return type is composite; covered = field covered.
 *  - Types percent (run summary): share of non-scalar types that are touched
 *    (status COVERED or PARTIAL); `fullyCovered` is reported separately.
 *  - Scalars are not part of type coverage.
 */
import type { AnalysisResult, ArgumentSource } from './types.js';
import type { SchemaModel, TypeKind } from './schema-model.js';

export interface HitStats {
  requests: number;
  occurrences: number;
}

export interface FieldHitData extends HitStats {
  minDepth: number;
  maxDepth: number;
  /** Every request selected the field only under an unevaluable @include/@skip. */
  conditionalOnly: boolean;
  aliases: string[];
  fragments: string[];
  /** path → number of requests (capped, see MAX_PATHS). */
  paths: Record<string, number>;
  /** test key (see testKey) → number of requests. */
  tests: Record<string, number>;
}

export interface ArgHitData extends HitStats {
  sources: ArgumentSource[];
}

export interface RequestCounters {
  total: number;
  valid: number;
  invalid: number;
  introspection: number;
  unresolved: number;
}

/** Aggregated coverage of a run. Plain JSON, mergeable. */
export interface CoverageData {
  requests: RequestCounters;
  fields: Record<string, FieldHitData>;
  arguments: Record<string, ArgHitData>;
  enumValues: Record<string, HitStats>;
  inputFields: Record<string, HitStats>;
  unionMembers: Record<string, HitStats>;
  /** test key → requests */
  tests: Record<string, HitStats>;
}

export const MAX_PATHS = 50;
export const MAX_ALIASES = 25;
export const UNKNOWN_TEST = 'unknown';

export interface TestRef {
  name?: string | null | undefined;
  suite?: string | null | undefined;
}

/** Stable test identifier: `suite::name`, `name` without suite, `unknown` without header. */
export function testKey(ref: TestRef | null | undefined): string {
  const name = ref?.name?.trim() || UNKNOWN_TEST;
  const suite = ref?.suite?.trim();
  return suite ? `${suite}::${name}` : name;
}

export function parseTestKey(key: string): { suite: string | null; name: string } {
  const i = key.indexOf('::');
  return i < 0 ? { suite: null, name: key } : { suite: key.slice(0, i), name: key.slice(i + 2) };
}

export function emptyCoverageData(): CoverageData {
  return {
    requests: { total: 0, valid: 0, invalid: 0, introspection: 0, unresolved: 0 },
    fields: {},
    arguments: {},
    enumValues: {},
    inputFields: {},
    unionMembers: {},
    tests: {},
  };
}

const addStats = (
  m: Record<string, HitStats>,
  key: string,
  requests: number,
  occurrences: number,
) => {
  const cur = m[key] ?? (m[key] = { requests: 0, occurrences: 0 });
  cur.requests += requests;
  cur.occurrences += occurrences;
};

const unionCapped = (a: string[], b: Iterable<string>, cap: number): string[] => {
  const s = new Set(a);
  for (const x of b) {
    if (s.size >= cap) break;
    s.add(x);
  }
  return [...s].sort();
};

function mergePaths(target: Record<string, number>, source: Record<string, number>): void {
  for (const [p, n] of Object.entries(source)) {
    if (p in target) target[p]! += n;
    else if (Object.keys(target).length < MAX_PATHS) target[p] = n;
  }
}

function mergeField(target: CoverageData, coord: string, f: FieldHitData): void {
  const cur = target.fields[coord];
  if (!cur) {
    target.fields[coord] = {
      ...f,
      aliases: [...f.aliases],
      fragments: [...f.fragments],
      paths: { ...f.paths },
      tests: { ...f.tests },
    };
    return;
  }
  cur.requests += f.requests;
  cur.occurrences += f.occurrences;
  cur.minDepth = Math.min(cur.minDepth, f.minDepth);
  cur.maxDepth = Math.max(cur.maxDepth, f.maxDepth);
  cur.conditionalOnly = cur.conditionalOnly && f.conditionalOnly;
  cur.aliases = unionCapped(cur.aliases, f.aliases, MAX_ALIASES);
  cur.fragments = unionCapped(cur.fragments, f.fragments, MAX_ALIASES);
  mergePaths(cur.paths, f.paths);
  for (const [t, n] of Object.entries(f.tests)) cur.tests[t] = (cur.tests[t] ?? 0) + n;
}

/** Merge `source` into `target` (mutates and returns target). */
export function mergeCoverageData(target: CoverageData, source: CoverageData): CoverageData {
  for (const k of Object.keys(target.requests) as (keyof RequestCounters)[]) {
    target.requests[k] += source.requests[k];
  }
  for (const [c, f] of Object.entries(source.fields)) mergeField(target, c, f);
  for (const [c, a] of Object.entries(source.arguments)) {
    const cur = target.arguments[c];
    if (!cur) target.arguments[c] = { ...a, sources: [...a.sources] };
    else {
      cur.requests += a.requests;
      cur.occurrences += a.occurrences;
      cur.sources = unionCapped(cur.sources, a.sources, 2) as ArgumentSource[];
    }
  }
  for (const key of ['enumValues', 'inputFields', 'unionMembers', 'tests'] as const) {
    for (const [c, s] of Object.entries(source[key]))
      addStats(target[key], c, s.requests, s.occurrences);
  }
  return target;
}

/** Convert one analysed request into CoverageData (requests = 1). */
export function coverageFromAnalysis(result: AnalysisResult, test?: TestRef | null): CoverageData {
  const data = emptyCoverageData();
  data.requests.total = 1;
  if (result.status === 'invalid') {
    data.requests.invalid = 1;
    return data;
  }
  data.requests.valid = 1;
  if (result.introspection) data.requests.introspection = 1;
  const tk = testKey(test);
  data.tests[tk] = { requests: 1, occurrences: 1 };
  for (const f of result.fields) {
    data.fields[f.coordinate] = {
      requests: 1,
      occurrences: f.occurrences,
      minDepth: f.minDepth,
      maxDepth: f.maxDepth,
      conditionalOnly: f.conditional,
      aliases: f.aliases.slice(0, MAX_ALIASES),
      fragments: f.fragments.slice(0, MAX_ALIASES),
      paths: Object.fromEntries(f.paths.slice(0, MAX_PATHS).map((p) => [p, 1])),
      tests: { [tk]: 1 },
    };
  }
  for (const a of result.arguments) {
    data.arguments[a.coordinate] = {
      requests: 1,
      occurrences: a.occurrences,
      sources: [...a.sources],
    };
  }
  for (const e of result.enumValues)
    data.enumValues[e.coordinate] = { requests: 1, occurrences: e.occurrences };
  for (const e of result.inputFields)
    data.inputFields[e.coordinate] = { requests: 1, occurrences: e.occurrences };
  for (const e of result.unionMembers)
    data.unionMembers[e.coordinate] = { requests: 1, occurrences: e.occurrences };
  return data;
}

/** In-memory accumulator used by the server as a write-behind buffer per run. */
export class CoverageAccumulator {
  private data = emptyCoverageData();

  add(result: AnalysisResult, test?: TestRef | null): void {
    mergeCoverageData(this.data, coverageFromAnalysis(result, test));
  }

  addUnresolved(): void {
    this.data.requests.total += 1;
    this.data.requests.unresolved += 1;
  }

  get isEmpty(): boolean {
    return this.data.requests.total === 0;
  }

  snapshot(): CoverageData {
    return mergeCoverageData(emptyCoverageData(), this.data);
  }

  /** Return accumulated data and reset (for batched flushes). */
  drain(): CoverageData {
    const d = this.data;
    this.data = emptyCoverageData();
    return d;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type CoverageStatus = 'covered' | 'partial' | 'uncovered';
export type FieldStatus = 'covered' | 'via_interface' | 'uncovered';

export interface Ratio {
  covered: number;
  total: number;
  /** 0..100, one decimal; 100 when total = 0. */
  percent: number;
}

export interface ArgCoverage {
  name: string;
  coordinate: string;
  used: boolean;
  requests: number;
}

export interface FieldCoverage {
  name: string;
  coordinate: string;
  type: string;
  namedType: string;
  namedTypeKind: TypeKind;
  status: FieldStatus;
  /** Covered for metric purposes (status covered, or via_interface with propagation). */
  counted: boolean;
  requests: number;
  occurrences: number;
  tests: number;
  maxDepth: number | null;
  conditionalOnly: boolean;
  /** Interfaces whose field covers this one (status via_interface). */
  viaInterfaces: string[];
  args: ArgCoverage[];
}

export interface ValueCoverage {
  name: string;
  coordinate: string;
  used: boolean;
  requests: number;
}

export interface TypeCoverage {
  name: string;
  kind: TypeKind;
  status: CoverageStatus;
  /** Fields (object/interface), members (union), values (enum), input fields (input). */
  ratio: Ratio;
  requests: number;
  fields: FieldCoverage[];
  values: ValueCoverage[];
}

export interface CoverageSummary {
  fields: Ratio;
  types: Ratio & { fullyCovered: number };
  operations: Ratio & { query: Ratio; mutation: Ratio; subscription: Ratio };
  arguments: Ratio;
  enumValues: Ratio;
  inputFields: Ratio;
  unionMembers: Ratio;
  edges: Ratio;
  requests: RequestCounters;
  tests: number;
  maxDepth: number;
  /** Distinct covered field coordinates whose min depth equals `depth`. */
  depth: { depth: number; fields: number }[];
}

export interface CoverageReport {
  summary: CoverageSummary;
  types: TypeCoverage[];
  uncovered: {
    fields: string[];
    types: string[];
    operations: string[];
    arguments: string[];
    enumValues: string[];
    inputFields: string[];
  };
}

export interface CoverageOptions {
  propagateInterfaceCoverage?: boolean;
}

export function ratio(covered: number, total: number): Ratio {
  return { covered, total, percent: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10 };
}

function statusOf(r: Ratio): CoverageStatus {
  if (r.total > 0 && r.covered === r.total) return 'covered';
  return r.covered > 0 ? 'partial' : 'uncovered';
}

export function computeCoverage(
  model: SchemaModel,
  data: CoverageData,
  options: CoverageOptions = {},
): CoverageReport {
  const propagate = options.propagateInterfaceCoverage === true;
  const byName = new Map(model.types.map((t) => [t.name, t]));
  const types: TypeCoverage[] = [];
  let fieldsCovered = 0;
  let fieldsTotal = 0;
  let argsUsed = 0;
  let argsTotal = 0;
  let edgesCovered = 0;
  let edgesTotal = 0;
  let enumUsed = 0;
  let enumTotal = 0;
  let inputUsed = 0;
  let inputTotal = 0;
  let membersUsed = 0;
  let membersTotal = 0;
  const uncovered: CoverageReport['uncovered'] = {
    fields: [],
    types: [],
    operations: [],
    arguments: [],
    enumValues: [],
    inputFields: [],
  };
  const roots = model.roots;
  const opRatios = { query: ratio(0, 0), mutation: ratio(0, 0), subscription: ratio(0, 0) };
  const depth = new Map<number, number>();

  for (const t of model.types) {
    if (t.kind === 'SCALAR') continue;
    const fields: FieldCoverage[] = [];
    const values: ValueCoverage[] = [];
    let r: Ratio;
    let requests = 0;

    if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
      for (const f of t.fields) {
        const hit = data.fields[f.coordinate];
        const viaInterfaces = hit
          ? []
          : t.interfaces.filter((i) => {
              const iface = byName.get(i);
              return iface?.fields.some((x) => x.name === f.name) && data.fields[`${i}.${f.name}`];
            });
        const status: FieldStatus = hit
          ? 'covered'
          : viaInterfaces.length > 0
            ? 'via_interface'
            : 'uncovered';
        const counted = status === 'covered' || (status === 'via_interface' && propagate);
        const args = f.args.map((a) => {
          const ah = data.arguments[a.coordinate];
          return {
            name: a.name,
            coordinate: a.coordinate,
            used: !!ah,
            requests: ah?.requests ?? 0,
          };
        });
        for (const a of args) {
          argsTotal += 1;
          if (a.used) argsUsed += 1;
          else uncovered.arguments.push(a.coordinate);
        }
        if (
          f.namedTypeKind === 'OBJECT' ||
          f.namedTypeKind === 'INTERFACE' ||
          f.namedTypeKind === 'UNION'
        ) {
          edgesTotal += 1;
          if (counted) edgesCovered += 1;
        }
        fieldsTotal += 1;
        if (counted) fieldsCovered += 1;
        else uncovered.fields.push(f.coordinate);
        if (hit) {
          requests = Math.max(requests, hit.requests);
          depth.set(hit.minDepth, (depth.get(hit.minDepth) ?? 0) + 1);
        }
        const opKind =
          t.name === roots.query
            ? 'query'
            : t.name === roots.mutation
              ? 'mutation'
              : t.name === roots.subscription
                ? 'subscription'
                : null;
        if (opKind) {
          const o = opRatios[opKind];
          opRatios[opKind] = ratio(o.covered + (counted ? 1 : 0), o.total + 1);
          if (!counted) uncovered.operations.push(f.coordinate);
        }
        fields.push({
          name: f.name,
          coordinate: f.coordinate,
          type: f.type,
          namedType: f.namedType,
          namedTypeKind: f.namedTypeKind,
          status,
          counted,
          requests: hit?.requests ?? 0,
          occurrences: hit?.occurrences ?? 0,
          tests: hit ? Object.keys(hit.tests).length : 0,
          maxDepth: hit?.maxDepth ?? null,
          conditionalOnly: hit?.conditionalOnly ?? false,
          viaInterfaces,
          args,
        });
      }
      r = ratio(fields.filter((f) => f.counted).length, fields.length);
    } else {
      const entries: { name: string; coordinate: string; hit: HitStats | undefined }[] =
        t.kind === 'UNION'
          ? t.possibleTypes.map((m) => ({
              name: m,
              coordinate: `${t.name}.${m}`,
              hit: data.unionMembers[`${t.name}.${m}`],
            }))
          : t.kind === 'ENUM'
            ? t.enumValues.map((v) => ({
                name: v,
                coordinate: `${t.name}.${v}`,
                hit: data.enumValues[`${t.name}.${v}`],
              }))
            : t.inputFields.map((f) => ({
                name: f.name,
                coordinate: f.coordinate,
                hit: data.inputFields[f.coordinate],
              }));
      for (const e of entries) {
        values.push({
          name: e.name,
          coordinate: e.coordinate,
          used: !!e.hit,
          requests: e.hit?.requests ?? 0,
        });
        if (e.hit) requests = Math.max(requests, e.hit.requests);
      }
      const used = values.filter((v) => v.used).length;
      r = ratio(used, values.length);
      const missing = values.filter((v) => !v.used).map((v) => v.coordinate);
      if (t.kind === 'UNION') {
        membersUsed += used;
        membersTotal += values.length;
      } else if (t.kind === 'ENUM') {
        enumUsed += used;
        enumTotal += values.length;
        uncovered.enumValues.push(...missing);
      } else {
        inputUsed += used;
        inputTotal += values.length;
        uncovered.inputFields.push(...missing);
      }
    }

    const status = statusOf(r);
    if (status === 'uncovered') uncovered.types.push(t.name);
    types.push({ name: t.name, kind: t.kind, status, ratio: r, requests, fields, values });
  }

  const touched = types.filter((t) => t.status !== 'uncovered').length;
  const ops = Object.values(opRatios);
  const depths = [...depth.keys()].sort((a, b) => a - b);
  return {
    summary: {
      fields: ratio(fieldsCovered, fieldsTotal),
      types: {
        ...ratio(touched, types.length),
        fullyCovered: types.filter((t) => t.status === 'covered').length,
      },
      operations: {
        ...ratio(
          ops.reduce((s, o) => s + o.covered, 0),
          ops.reduce((s, o) => s + o.total, 0),
        ),
        ...opRatios,
      },
      arguments: ratio(argsUsed, argsTotal),
      enumValues: ratio(enumUsed, enumTotal),
      inputFields: ratio(inputUsed, inputTotal),
      unionMembers: ratio(membersUsed, membersTotal),
      edges: ratio(edgesCovered, edgesTotal),
      requests: { ...data.requests },
      tests: Object.keys(data.tests).length,
      maxDepth: Object.values(data.fields).reduce((m, f) => Math.max(m, f.maxDepth), 0),
      depth: depths.map((d) => ({ depth: d, fields: depth.get(d)! })),
    },
    types,
    uncovered: {
      fields: uncovered.fields.sort(),
      types: uncovered.types.sort(),
      operations: uncovered.operations.sort(),
      arguments: uncovered.arguments.sort(),
      enumValues: uncovered.enumValues.sort(),
      inputFields: uncovered.inputFields.sort(),
    },
  };
}

/** Test → covered field coordinates (the "test coverage" slice). */
export function fieldsByTest(data: CoverageData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [coord, f] of Object.entries(data.fields)) {
    for (const t of Object.keys(f.tests)) (out[t] ??= []).push(coord);
  }
  for (const k of Object.keys(out)) out[k]!.sort();
  return out;
}
