import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  CoverageAccumulator,
  analyzeRequest,
  buildSchemaModel,
  computeCoverage,
  planGaps,
} from '../src/index.js';

const schema = buildSchema(
  readFileSync(new URL('./fixtures/schema.graphql', import.meta.url), 'utf8'),
);
const model = buildSchemaModel(schema);

function coverageOf(queries: { query: string; variables?: Record<string, unknown> }[]) {
  const acc = new CoverageAccumulator();
  for (const q of queries)
    acc.add(analyzeRequest(schema, { query: q.query, variables: q.variables ?? null }));
  return { acc, report: computeCoverage(model, acc.snapshot()) };
}

const baseline = [
  { query: '{ me { id name } }' },
  { query: 'query($id: ID!) { user(id: $id) { id posts { id title } } }', variables: { id: '1' } },
];

describe('planGaps', () => {
  it('generates valid queries that cover exactly what they promise', () => {
    const { report } = coverageOf(baseline);
    const plan = planGaps(model, report);
    expect(plan.suggestions.length).toBeGreaterThan(0);
    for (const s of plan.suggestions) {
      const result = analyzeRequest(schema, { query: s.query, variables: s.variables });
      expect(result.errors, s.query).toEqual([]);
      expect(result.status).toBe('valid');
      expect(result.operationType).toBe(s.operationType);
      const selected = new Set(result.fields.map((f) => f.coordinate));
      for (const c of s.gain) expect(selected, `${s.id} → ${c}\n${s.query}`).toContain(c);
    }
  });

  it('reaches 100% field coverage when every suggestion is replayed', () => {
    const { acc, report } = coverageOf(baseline);
    const plan = planGaps(model, report);
    expect(plan.unreachable).toEqual([]);
    for (const s of plan.suggestions)
      acc.add(analyzeRequest(schema, { query: s.query, variables: s.variables }));
    const after = computeCoverage(model, acc.snapshot());
    expect(after.summary.fields.percent).toBe(100);
    expect(plan.projected).toBe(100);
  });

  it('orders by marginal gain and projects monotonically growing coverage', () => {
    const { report } = coverageOf(baseline);
    const plan = planGaps(model, report);
    const gains = plan.suggestions.map((s) => s.marginalGain);
    expect([...gains].sort((a, b) => b - a)).toEqual(gains);
    const after = plan.suggestions.map((s) => s.coverageAfter);
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1]!);
    expect(after[0]).toBeGreaterThan(report.summary.fields.percent);
  });

  it('prefers queries and already tested paths over mutations', () => {
    const { report } = coverageOf(baseline);
    const plan = planGaps(model, report);
    const post = plan.suggestions.find((s) => s.id === 'type:Post')!;
    expect(post.operationType).toBe('query');
    // Query.user → User.posts is already tested and needs one argument; Query.posts needs none.
    expect(post.path).toEqual(['Query.posts']);
    expect(post.fields).toEqual(expect.arrayContaining(['Post.body', 'Post.comments']));
  });

  it('declares required arguments as variables with sample values', () => {
    const { report } = coverageOf(baseline);
    const plan = planGaps(model, report);
    const del = plan.suggestions.find((s) => s.id === 'root:Mutation.deletePost')!;
    expect(del.operationType).toBe('mutation');
    expect(del.query).toContain('mutation CoverMutationDeletePost($id: ID!)');
    expect(del.variables).toEqual({ id: '1' });
    const create = plan.suggestions.find((s) => s.id === 'root:Mutation.createPost')!;
    expect(create.variables).toEqual({
      input: { title: 'example', body: 'example', tags: ['example'], status: 'DRAFT' },
    });
    const update = plan.suggestions.find((s) => s.id === 'root:Mutation.updateRole')!;
    expect(update.variables).toEqual({ userId: '1', role: 'ADMIN' });
  });

  it('narrows unions and interfaces with inline fragments', () => {
    const { report } = coverageOf([
      ...baseline,
      { query: '{ feed { id title author { id } } search(text: "x") { __typename } }' },
    ]);
    const plan = planGaps(model, report);
    const video = plan.suggestions.find((s) => s.id === 'type:Video')!;
    expect(video.query).toMatch(/\.\.\. on Video \{/);
    expect(video.fields).toContain('Video.durationSec');
  });

  it('returns nothing to do for full coverage', () => {
    const { acc, report } = coverageOf(baseline);
    for (const s of planGaps(model, report).suggestions)
      acc.add(analyzeRequest(schema, { query: s.query, variables: s.variables }));
    const plan = planGaps(model, computeCoverage(model, acc.snapshot()));
    expect(plan.suggestions).toEqual([]);
    expect(plan.projected).toBe(100);
  });

  it('reports fields unreachable from any root', () => {
    const s = buildSchema('type Query { a: Int } type Orphan { x: Int }');
    const m = buildSchemaModel(s);
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(s, { query: '{ a }' }));
    const plan = planGaps(m, computeCoverage(m, acc.snapshot()));
    expect(plan.unreachable).toEqual(['Orphan.x']);
    expect(plan.suggestions).toEqual([]);
  });

  it('respects the limit', () => {
    const { report } = coverageOf(baseline);
    expect(planGaps(model, report, { limit: 2 }).suggestions).toHaveLength(2);
  });
});

describe('planGaps on edge-case schemas', () => {
  const sdl = `
    scalar DateTime
    enum Mode { FAST SLOW }
    input Deep { next: Deep, n: Int!, at: DateTime, mode: Mode, flags: [Boolean!] }
    type Leaf { child: Leaf }
    union Any = Leaf | Box
    type Box {
      id: ID!
      size(scale: Float!, round: Boolean!, count: Int!, when: DateTime!, mode: Mode!, ids: [ID!]!): Int
      at(id: ID!): DateTime
      leaf: Leaf
      any: Any
      old: Box @deprecated(reason: "use box")
      deep(input: Deep!): Int
      self(id: ID!): Box
    }
    type Hidden { x: Int }
    type Query {
      box(id: ID!): Box
      legacy: Hidden @deprecated(reason: "gone")
    }
  `;
  const s = buildSchema(sdl);
  const m = buildSchemaModel(s);

  it('builds valid operations for every argument kind, leaf shape and naming clash', () => {
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(s, { query: '{ box(id: "1") { id } }' }));
    const plan = planGaps(m, computeCoverage(m, acc.snapshot()));
    for (const sug of plan.suggestions) {
      const r = analyzeRequest(s, { query: sug.query, variables: sug.variables });
      expect(r.errors, sug.query).toEqual([]);
      const selected = new Set(r.fields.map((f) => f.coordinate));
      for (const c of sug.gain) expect(selected, `${c}\n${sug.query}`).toContain(c);
    }
    const box = plan.suggestions.find((x) => x.id === 'type:Box')!;
    expect(box.variables).toMatchObject({
      id: '1',
      scale: 1.5,
      round: true,
      count: 1,
      when: 'example',
      mode: 'FAST',
      ids: ['1'],
      atId: '1',
      selfId: '1',
    });
    expect(box.variables.input).toMatchObject({ n: 1, at: 'example', mode: 'FAST', flags: [true] });
    expect(box.query).toContain('leaf { __typename }');
    expect(box.query).toContain('any { __typename }');
    expect(box.query).toContain('old { id }');
    expect(box.deprecated).toEqual(['Box.old']);
    // The deprecated field leads to Hidden only through Query.legacy, still reachable.
    expect(plan.suggestions.find((x) => x.id === 'type:Hidden')!.path).toEqual(['Query.legacy']);
  });

  it('caps deeply nested input samples', () => {
    const r = buildSchema(`
      input A { b: B! } input B { c: C! } input C { d: D! } input D { e: E! } input E { v: Int! }
      type Query { f: Int, g(a: A!): Int }
    `);
    const rm = buildSchemaModel(r);
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(r, { query: '{ f }' }));
    const g = planGaps(rm, computeCoverage(rm, acc.snapshot())).suggestions[0]!;
    expect(g.variables).toEqual({ a: { b: { c: { d: { e: {} } } } } });
  });

  it('keeps variable names unique along a path with repeated field names', () => {
    const r = buildSchema(`
      type C { x: Int } type B { a(id: ID!): C } type A { a(id: ID!): B }
      type Query { a(id: ID!): A, ok: Int }
    `);
    const rm = buildSchemaModel(r);
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(r, { query: '{ ok }' }));
    const c = planGaps(rm, computeCoverage(rm, acc.snapshot())).suggestions.find(
      (x) => x.id === 'type:C',
    )!;
    expect(Object.keys(c.variables)).toEqual(['id', 'aId', 'aId2']);
    expect(analyzeRequest(r, { query: c.query, variables: c.variables }).errors).toEqual([]);
  });
});

describe('planGaps keeps suggested queries cheap', () => {
  it('asks list fields with an optional page-size argument for one item', () => {
    const s = buildSchema(`
      type Item { id: ID!, name: String, tags(first: Int): [String!] }
      type Query { items(limit: Int, offset: Int): [Item!]!, one(id: ID!): Item, ok: Int }
    `);
    const m = buildSchemaModel(s);
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(s, { query: '{ ok }' }));
    const plan = planGaps(m, computeCoverage(m, acc.snapshot()));
    const item = plan.suggestions.find((x) => x.id === 'type:Item')!;
    expect(item.query).toContain('items(limit: 1) {');
    expect(item.query).toContain('tags(first: 1)');
    expect(plan.suggestions.find((x) => x.id === 'root:Query.one')!.query).not.toContain(': 1');
    for (const x of plan.suggestions)
      expect(analyzeRequest(s, { query: x.query, variables: x.variables }).errors).toEqual([]);
  });
});
