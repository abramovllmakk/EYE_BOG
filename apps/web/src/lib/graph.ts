import ELK, { type ElkNode } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { SchemaModel, TypeCoverage, TypeModel } from './api';

/** Layout runs in a Web Worker so large schemas never block the UI thread. */
const elk = new ELK({ workerUrl });

export const CARD_WIDTH = 280;
export const HEADER_H = 52;
export const ROW_H = 24;
export const MAX_ROWS = 24;

export type RootChoice = 'query' | 'mutation' | 'subscription' | 'all';

export interface GraphOptions {
  root: RootChoice;
  focus: string | null;
  depth: number;
  showScalars: boolean;
  showEnums: boolean;
  showInputs: boolean;
  onlyUncovered: boolean;
  expanded: Set<string>;
  /** Hard cap before automatic neighbourhood limiting kicks in. */
  maxNodes: number;
}

export interface Row {
  key: string;
  name: string;
  detail: string;
  status: 'covered' | 'partial' | 'uncovered' | 'via_interface';
  requests: number;
  /** Target type of the edge leaving this row, if drawn. */
  to: string | null;
  link: 'field' | null;
}

export interface CardData {
  type: TypeModel;
  coverage: TypeCoverage | null;
  rows: Row[];
  hidden: number;
  [key: string]: unknown;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  status: Row['status'];
  kind: 'field' | 'implements' | 'member';
}

export interface BuiltGraph {
  cards: Map<string, CardData>;
  edges: GraphEdge[];
  limited: boolean;
  totalCandidates: number;
}

function allowed(t: TypeModel, o: GraphOptions): boolean {
  if (t.kind === 'SCALAR') return o.showScalars;
  if (t.kind === 'ENUM') return o.showEnums;
  if (t.kind === 'INPUT_OBJECT') return o.showInputs;
  return true;
}

/** Outgoing relations used for reachability / neighbourhoods (fields, args, implements, members). */
function adjacency(model: SchemaModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);
  for (const e of model.edges) add(e.from, e.to);
  for (const t of model.types)
    for (const f of t.fields) for (const a of f.args) add(t.name, a.namedType);
  return out;
}

function bfs(
  starts: string[],
  next: (n: string) => Iterable<string>,
  depth: number,
  ok: (n: string) => boolean,
): string[] {
  const seen = new Set(starts.filter(ok));
  let frontier = [...seen];
  for (let d = 0; d < depth && frontier.length; d++) {
    const nf: string[] = [];
    for (const n of frontier) {
      for (const m of next(n)) {
        if (seen.has(m) || !ok(m)) continue;
        seen.add(m);
        nf.push(m);
      }
    }
    frontier = nf;
  }
  return [...seen];
}

export function buildGraph(
  model: SchemaModel,
  coverage: TypeCoverage[],
  o: GraphOptions,
): BuiltGraph {
  const byName = new Map(model.types.map((t) => [t.name, t]));
  const cov = new Map(coverage.map((t) => [t.name, t]));
  const out = adjacency(model);
  const inc = new Map<string, Set<string>>();
  for (const [a, bs] of out)
    for (const b of bs) (inc.get(b) ?? inc.set(b, new Set()).get(b)!).add(a);
  // Reachability walks through every allowed type; "only uncovered" filters what is shown afterwards,
  // so a fully covered root (e.g. Query) still leads to its uncovered descendants.
  const ok = (n: string) => {
    const t = byName.get(n);
    return !!t && allowed(t, o);
  };
  const show = (n: string) => !o.onlyUncovered || n === o.focus || cov.get(n)?.status !== 'covered';

  const roots =
    o.root === 'all'
      ? model.types.map((t) => t.name)
      : [model.roots[o.root]].filter((x): x is string => !!x);
  let names: string[];
  if (o.focus && byName.has(o.focus)) {
    const both = (n: string) => [...(out.get(n) ?? []), ...(inc.get(n) ?? [])];
    names = bfs([o.focus], both, o.depth, (n) => n === o.focus || ok(n));
  } else {
    names = o.root === 'all' ? roots.filter(ok) : bfs(roots, (n) => out.get(n) ?? [], Infinity, ok);
  }
  names = names.filter(show);
  const totalCandidates = names.length;
  let limited = false;
  if (!o.focus && names.length > o.maxNodes) {
    // Large schema: grow the neighbourhood of the roots until the cap is reached.
    limited = true;
    let d = 1;
    let cur = bfs(roots.slice(0, 50), (n) => out.get(n) ?? [], d, ok);
    while (true) {
      const nextLevel = bfs(roots.slice(0, 50), (n) => out.get(n) ?? [], d + 1, ok);
      if (nextLevel.length > o.maxNodes || nextLevel.length === cur.length) break;
      cur = nextLevel;
      d++;
    }
    names = cur.filter(show).slice(0, o.maxNodes);
  }
  const visible = new Set(names);

  const cards = new Map<string, CardData>();
  const edges: GraphEdge[] = [];
  for (const name of names) {
    const t = byName.get(name)!;
    const c = cov.get(name) ?? null;
    let rows: Row[] = [];
    if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') {
      rows = (
        c?.fields ??
        t.fields.map((f) => ({
          name: f.name,
          type: f.type,
          namedType: f.namedType,
          status: 'uncovered' as const,
          requests: 0,
        }))
      ).map((f) => ({
        key: `f:${f.name}`,
        name: f.name,
        detail: f.type,
        status: f.status,
        requests: f.requests,
        to: visible.has(f.namedType) ? f.namedType : null,
        link: 'field' as const,
      }));
    } else if (t.kind === 'INPUT_OBJECT') {
      rows = t.inputFields.map((f) => {
        const v = c?.values.find((x) => x.name === f.name);
        return {
          key: `f:${f.name}`,
          name: f.name,
          detail: f.type,
          status: v?.used ? 'covered' : 'uncovered',
          requests: v?.requests ?? 0,
          to: visible.has(f.namedType) ? f.namedType : null,
          link: null,
        };
      });
    } else if (t.kind === 'UNION' || t.kind === 'ENUM') {
      rows = (t.kind === 'UNION' ? t.possibleTypes : t.enumValues).map((v) => {
        const u = c?.values.find((x) => x.name === v);
        return {
          key: `v:${v}`,
          name: v,
          detail: '',
          status: u?.used ? 'covered' : 'uncovered',
          requests: u?.requests ?? 0,
          to: t.kind === 'UNION' && visible.has(v) ? v : null,
          link: null,
        };
      });
    }
    if (o.onlyUncovered && name !== o.focus) rows = rows.filter((r) => r.status !== 'covered');
    const limit = o.expanded.has(name) ? rows.length : MAX_ROWS;
    const shown = rows.slice(0, limit);
    cards.set(name, { type: t, coverage: c, rows: shown, hidden: rows.length - shown.length });
    for (const r of shown) {
      if (r.to) {
        edges.push({
          id: `${name}.${r.key}`,
          source: name,
          sourceHandle: r.key,
          target: r.to,
          status: r.status,
          kind: t.kind === 'UNION' ? 'member' : 'field',
        });
      }
    }
    for (const i of t.interfaces) {
      if (visible.has(i))
        edges.push({
          id: `${name}>${i}`,
          source: name,
          sourceHandle: 'impl',
          target: i,
          status: 'uncovered',
          kind: 'implements',
        });
    }
  }
  return { cards, edges, limited, totalCandidates };
}

export const cardHeight = (c: CardData) =>
  HEADER_H + Math.max(c.rows.length, 1) * ROW_H + (c.hidden > 0 ? ROW_H : 0) + 8;

export async function layout(g: BuiltGraph): Promise<Map<string, { x: number; y: number }>> {
  const children: ElkNode[] = [...g.cards.entries()].map(([id, c]) => ({
    id,
    width: CARD_WIDTH,
    height: cardHeight(c),
    layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' },
    ports: [
      { id: `${id}::in`, layoutOptions: { 'elk.port.side': 'WEST' } },
      ...c.rows.map((r) => ({ id: `${id}::${r.key}`, layoutOptions: { 'elk.port.side': 'EAST' } })),
      { id: `${id}::impl`, layoutOptions: { 'elk.port.side': 'NORTH' } },
    ],
  }));
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '28',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children,
    edges: g.edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({
        id: e.id,
        sources: [`${e.source}::${e.sourceHandle}`],
        targets: [`${e.target}::in`],
      })),
  });
  return new Map((res.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}
