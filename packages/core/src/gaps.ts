/**
 * Coverage gap planner: turns "these fields are uncovered" into ready-to-run GraphQL queries.
 *
 * For every type with uncovered fields the planner finds the cheapest path from a root type
 * (preferring Query, fields that tests already use and fields without required arguments),
 * prints one operation that walks that path and selects every uncovered field of the type,
 * and orders the suggestions greedily by how many new fields each one covers.
 */
import type { CoverageReport, Ratio } from './coverage.js';
import type { FieldModel, SchemaModel, TypeModel } from './schema-model.js';
import type { OperationKind } from './types.js';

export interface GapSuggestion {
  /** Stable id: `type:<Type>` or `root:<Root.field>`. */
  id: string;
  /** Type whose fields are selected (for root suggestions — the root type). */
  target: string;
  operationType: OperationKind;
  operationName: string;
  /** Field coordinates walked from the root to the target type (fragments are not listed). */
  path: string[];
  /** Uncovered fields of the target that the query selects. */
  fields: string[];
  /** Every field that becomes covered (targets, uncovered hops, helper sub-selections). */
  gain: string[];
  /** Number of `gain` fields not already gained by earlier suggestions. */
  marginalGain: number;
  /** Field coverage, %, after this and all earlier suggestions. */
  coverageAfter: number;
  /** Deprecated fields among `fields`. */
  deprecated: string[];
  query: string;
  /** Example values for the declared variables; replace with real test data. */
  variables: Record<string, unknown>;
}

export interface GapPlan {
  fields: Ratio;
  /** Field coverage, %, if every suggestion is added to the tests. */
  projected: number;
  suggestions: GapSuggestion[];
  /** Uncovered fields that cannot be reached from any root type. */
  unreachable: string[];
}

export interface GapPlanOptions {
  /** Upper bound on the number of suggestions (default 500). */
  limit?: number;
}

type Hop =
  | { kind: 'field'; from: string; field: FieldModel; to: string }
  | { kind: 'fragment'; from: string; to: string };

interface Reach {
  cost: number;
  root: OperationKind;
  hops: Hop[];
}

const COMPOSITE = new Set(['OBJECT', 'INTERFACE', 'UNION']);
/** Starting cost per root: prefer read-only queries over subscriptions and mutations. */
const ROOT_COST: Record<OperationKind, number> = { query: 0, subscription: 4, mutation: 6 };
const LEAF_PREFERENCE = ['id', 'name', 'title', 'key', 'code'];
/** Optional page-size arguments set to 1 on list fields so suggested queries stay cheap. */
const PAGE_ARGS = new Set(['limit', 'first', 'take', 'pageSize', 'perPage', 'size']);

const isRequired = (type: string) => type.endsWith('!');
const requiredArgs = (f: FieldModel) => f.args.filter((a) => isRequired(a.type));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Multi-source Dijkstra over composite types; returns the cheapest path to every reachable type.
 *
 * Widening a concrete type to its interface (`... on Node` inside `User`) is only allowed as the
 * last step, to select the interface's own fields. Expanding further from such a state would allow
 * nonsense like `user { ... on Node { ... on Post { body } } }`, which validates but never returns data.
 */
function reachAll(
  model: SchemaModel,
  byName: Map<string, TypeModel>,
  counted: Set<string>,
): Map<string, Reach> {
  const best = new Map<string, Reach>();
  const done = new Set<string>();
  const frontier: { key: string; type: string; terminal: boolean; reach: Reach }[] = [];
  const relax = (type: string, reach: Reach, terminal = false) => {
    const key = terminal ? `${type}#widened` : type;
    const cur = best.get(key);
    if (done.has(key) || (cur && cur.cost <= reach.cost)) return;
    best.set(key, reach);
    frontier.push({ key, type, terminal, reach });
  };
  for (const kind of ['query', 'mutation', 'subscription'] as const) {
    const root = model.roots[kind];
    if (root && byName.has(root)) relax(root, { cost: ROOT_COST[kind], root: kind, hops: [] });
  }
  while (frontier.length) {
    let i = 0;
    for (let j = 1; j < frontier.length; j++)
      if (frontier[j]!.reach.cost < frontier[i]!.reach.cost) i = j;
    const { key, type, terminal, reach } = frontier.splice(i, 1)[0]!;
    if (done.has(key) || best.get(key) !== reach) continue;
    done.add(key);
    const t = byName.get(type);
    if (!t || terminal) continue;
    for (const f of t.fields) {
      if (!COMPOSITE.has(f.namedTypeKind)) continue;
      const cost =
        1 +
        (counted.has(f.coordinate) ? 0 : 0.5) +
        requiredArgs(f).length * 0.3 +
        (f.deprecated ? 3 : 0);
      relax(f.namedType, {
        cost: reach.cost + cost,
        root: reach.root,
        hops: [...reach.hops, { kind: 'field', from: type, field: f, to: f.namedType }],
      });
    }
    // Narrow an interface / union to a member with `... on Member`.
    for (const member of t.possibleTypes)
      relax(member, {
        cost: reach.cost + 0.05,
        root: reach.root,
        hops: [...reach.hops, { kind: 'fragment', from: type, to: member }],
      });
    // Widen a concrete type to one of its interfaces with `... on Interface` (terminal step).
    for (const iface of t.interfaces)
      relax(
        iface,
        {
          cost: reach.cost + 0.05,
          root: reach.root,
          hops: [...reach.hops, { kind: 'fragment', from: type, to: iface }],
        },
        true,
      );
  }
  // Collapse the two states of every type into its cheapest reach.
  const out = new Map<string, Reach>();
  for (const [key, reach] of best) {
    const type = key.replace(/#widened$/, '');
    const cur = out.get(type);
    if (!cur || reach.cost < cur.cost) out.set(type, reach);
  }
  return out;
}

function sampleValue(type: string, byName: Map<string, TypeModel>, depth = 0): unknown {
  const t = type.replace(/!$/, '');
  if (t.startsWith('[')) return [sampleValue(t.slice(1, -1), byName, depth)];
  switch (t) {
    case 'ID':
      return '1';
    case 'String':
      return 'example';
    case 'Int':
      return 1;
    case 'Float':
      return 1.5;
    case 'Boolean':
      return true;
  }
  const named = byName.get(t);
  if (named?.kind === 'ENUM') return named.enumValues[0];
  if (named?.kind === 'INPUT_OBJECT') {
    if (depth > 3) return {};
    // Required fields always; optional ones only when they are plain scalars or enums, so the
    // sample also exercises input-field coverage without inventing deep nested objects.
    return Object.fromEntries(
      named.inputFields
        .filter((f) => {
          if (isRequired(f.type)) return true;
          const kind = byName.get(f.namedType)?.kind;
          return kind === 'SCALAR' || kind === 'ENUM';
        })
        .map((f) => [f.name, sampleValue(f.type, byName, depth + 1)]),
    );
  }
  return 'example';
}

/** Builds one operation: variables, argument lists and the nested selection text. */
class OperationBuilder {
  private readonly vars = new Map<string, string>();
  readonly variables: Record<string, unknown> = {};

  constructor(private readonly byName: Map<string, TypeModel>) {}

  args(f: FieldModel): string {
    const parts = requiredArgs(f).map((a) => {
      let name = a.name;
      if (this.vars.has(name)) name = `${f.name}${cap(a.name)}`;
      for (let n = 2; this.vars.has(name); n++) name = `${f.name}${cap(a.name)}${n}`;
      this.vars.set(name, a.type);
      this.variables[name] = sampleValue(a.type, this.byName);
      return `${a.name}: $${name}`;
    });
    // Keep generated tests cheap: ask list fields for a single item when they take a page size.
    // Real APIs enforce complexity limits and some fields are only allowed for one entity.
    const page = f.type.includes('[')
      ? f.args.find((a) => !isRequired(a.type) && PAGE_ARGS.has(a.name) && /int/i.test(a.namedType))
      : undefined;
    if (page) parts.push(`${page.name}: 1`);
    return parts.length ? `(${parts.join(', ')})` : '';
  }

  /** Smallest valid sub-selection for a composite type; returns the field it selects, if any. */
  leaf(typeName: string): { text: string; field: FieldModel | null } {
    const t = this.byName.get(typeName);
    if (!t || t.kind === 'UNION') return { text: '__typename', field: null };
    const simple = t.fields.filter(
      (f) => !COMPOSITE.has(f.namedTypeKind) && !requiredArgs(f).length,
    );
    const pick =
      LEAF_PREFERENCE.map((n) => simple.find((f) => f.name === n)).find(Boolean) ?? simple[0];
    return pick ? { text: pick.name, field: pick } : { text: '__typename', field: null };
  }

  print(kind: OperationKind, name: string, body: string[]): string {
    const decl = [...this.vars].map(([n, t]) => `$${n}: ${t}`).join(', ');
    return [`${kind} ${name}${decl ? `(${decl})` : ''} {`, ...body, '}'].join('\n');
  }
}

interface Draft {
  id: string;
  target: string;
  operationType: OperationKind;
  operationName: string;
  path: string[];
  fields: string[];
  gain: string[];
  deprecated: string[];
  query: string;
  variables: Record<string, unknown>;
  cost: number;
}

function draft(
  byName: Map<string, TypeModel>,
  counted: Set<string>,
  id: string,
  target: string,
  reach: Reach,
  targets: FieldModel[],
  operationName: string,
): Draft {
  const op = new OperationBuilder(byName);
  const lines: string[] = [];
  const gain = new Set<string>();
  const pad = (n: number) => '  '.repeat(n);
  let depth = 1;
  for (const hop of reach.hops) {
    if (hop.kind === 'field') {
      lines.push(`${pad(depth)}${hop.field.name}${op.args(hop.field)} {`);
      if (!counted.has(hop.field.coordinate)) gain.add(hop.field.coordinate);
    } else {
      lines.push(`${pad(depth)}... on ${hop.to} {`);
    }
    depth++;
  }
  for (const f of targets) {
    gain.add(f.coordinate);
    const args = op.args(f);
    if (COMPOSITE.has(f.namedTypeKind)) {
      const leaf = op.leaf(f.namedType);
      lines.push(`${pad(depth)}${f.name}${args} { ${leaf.text} }`);
      if (leaf.field && !counted.has(leaf.field.coordinate)) gain.add(leaf.field.coordinate);
    } else {
      lines.push(`${pad(depth)}${f.name}${args}`);
    }
  }
  for (let d = depth - 1; d >= 1; d--) lines.push(`${pad(d)}}`);
  return {
    id,
    target,
    operationType: reach.root,
    operationName,
    path: reach.hops.flatMap((h) => (h.kind === 'field' ? [h.field.coordinate] : [])),
    fields: targets.map((f) => f.coordinate),
    gain: [...gain],
    deprecated: targets.filter((f) => f.deprecated).map((f) => f.coordinate),
    query: op.print(reach.root, operationName, lines),
    variables: op.variables,
    cost: reach.cost,
  };
}

/** Plans the smallest set of queries that would cover the currently uncovered fields. */
export function planGaps(
  model: SchemaModel,
  report: CoverageReport,
  options: GapPlanOptions = {},
): GapPlan {
  const byName = new Map(model.types.map((t) => [t.name, t]));
  const counted = new Set<string>();
  for (const t of report.types) for (const f of t.fields) if (f.counted) counted.add(f.coordinate);
  const uncovered = new Set(report.uncovered.fields);
  const reach = reachAll(model, byName, counted);
  const rootKind = new Map<string, OperationKind>();
  for (const kind of ['query', 'mutation', 'subscription'] as const) {
    const r = model.roots[kind];
    if (r) rootKind.set(r, kind);
  }

  const drafts: Draft[] = [];
  const unreachable: string[] = [];
  for (const t of model.types) {
    if (t.kind !== 'OBJECT' && t.kind !== 'INTERFACE') continue;
    const targets = t.fields.filter((f) => uncovered.has(f.coordinate));
    if (!targets.length) continue;
    const r = reach.get(t.name);
    if (!r) {
      unreachable.push(...targets.map((f) => f.coordinate));
      continue;
    }
    const kind = rootKind.get(t.name);
    if (kind) {
      // Root fields are operations: one call per field, each is its own test.
      for (const f of targets)
        drafts.push(
          draft(
            byName,
            counted,
            `root:${f.coordinate}`,
            t.name,
            { ...r, root: kind },
            [f],
            `Cover${cap(kind)}${cap(f.name)}`,
          ),
        );
    } else {
      drafts.push(draft(byName, counted, `type:${t.name}`, t.name, r, targets, `Cover${t.name}`));
    }
  }

  // Greedy ordering: the suggestion that covers the most new fields first, cheaper paths on ties.
  const total = report.summary.fields.total;
  let covered = report.summary.fields.covered;
  const gained = new Set<string>();
  const ordered: GapSuggestion[] = [];
  const pool = [...drafts];
  const limit = options.limit ?? 500;
  while (pool.length && ordered.length < limit) {
    let bestIdx = 0;
    let bestGain = -1;
    pool.forEach((d, i) => {
      const g = d.gain.filter((c) => !gained.has(c)).length;
      if (
        g > bestGain ||
        (g === bestGain &&
          (d.cost < pool[bestIdx]!.cost ||
            (d.cost === pool[bestIdx]!.cost && d.id < pool[bestIdx]!.id)))
      ) {
        bestIdx = i;
        bestGain = g;
      }
    });
    const d = pool.splice(bestIdx, 1)[0]!;
    for (const c of d.gain) gained.add(c);
    covered += bestGain;
    const { cost: _cost, ...rest } = d;
    ordered.push({
      ...rest,
      marginalGain: bestGain,
      // A suggestion exists only for an uncovered field, so total > 0 and covered <= total here.
      coverageAfter: Math.round((covered / total) * 1000) / 10,
    });
  }

  return {
    fields: report.summary.fields,
    projected: ordered.length
      ? ordered[ordered.length - 1]!.coverageAfter
      : report.summary.fields.percent,
    suggestions: ordered,
    unreachable: unreachable.sort(),
  };
}
