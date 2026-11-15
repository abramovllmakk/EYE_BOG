import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  analyzeRequest,
  buildSchemaModel,
  computeCoverage,
  CoverageAccumulator,
} from '@gqlcov/core';
import { buildGraph, cardHeight, MAX_ROWS, type GraphOptions } from './graph-model';

const schema = buildSchema(
  readFileSync(new URL('../../../../demo/server/src/schema.graphql', import.meta.url), 'utf8'),
);
const model = buildSchemaModel(schema);
const acc = new CoverageAccumulator();
for (const q of ['{ viewer { id name role } }', '{ feed { title } }', '{ users { id } }'])
  acc.add(analyzeRequest(schema, { query: q }));
const types = computeCoverage(model, acc.snapshot()).types;

const opts = (o: Partial<GraphOptions> = {}): GraphOptions => ({
  root: 'query',
  focus: null,
  depth: 2,
  showScalars: false,
  showEnums: false,
  showInputs: false,
  onlyUncovered: false,
  expanded: new Set(),
  maxNodes: 500,
  ...o,
});

describe('buildGraph', () => {
  it('shows types reachable from the chosen root, without scalars/enums/inputs by default', () => {
    const g = buildGraph(model, types, opts());
    expect(g.cards.has('Query')).toBe(true);
    expect(g.cards.has('Comment')).toBe(true);
    expect(g.cards.has('Mutation')).toBe(false);
    expect(g.cards.has('String')).toBe(false);
    expect(g.cards.has('Role')).toBe(false);
    expect(g.cards.has('PostFilter')).toBe(false);
    const m = buildGraph(
      model,
      types,
      opts({ root: 'mutation', showInputs: true, showEnums: true }),
    );
    expect(m.cards.has('Mutation')).toBe(true);
    expect(m.cards.has('CreatePostInput')).toBe(true);
    expect(m.cards.has('PostStatus')).toBe(true);
  });

  it('only-uncovered walks through a fully covered root but hides covered types and fields', () => {
    const full = computeCoverage(
      model,
      (() => {
        const a = new CoverageAccumulator();
        a.add(
          analyzeRequest(schema, {
            query:
              '{ viewer { id } user(id: "1") { id } users { id } node(id: "1") { id } post(id: "1") { id } posts { id } feed { id } search(text: "") { __typename } tags { name } }',
          }),
        );
        return a.snapshot();
      })(),
    ).types;
    expect(full.find((t) => t.name === 'Query')!.status).toBe('covered');
    const g = buildGraph(model, full, opts({ onlyUncovered: true }));
    expect(g.cards.has('Query')).toBe(false);
    expect(g.cards.size).toBeGreaterThan(3);
    const user = g.cards.get('User')!;
    expect(user.rows.some((r) => r.name === 'id')).toBe(false);
    expect(user.rows.some((r) => r.name === 'bio')).toBe(true);
  });

  it('focus shows the neighbourhood in both directions up to the depth', () => {
    const g1 = buildGraph(model, types, opts({ focus: 'Comment', depth: 1 }));
    expect([...g1.cards.keys()].sort()).toEqual([
      'Comment',
      'CommentEdge',
      'Mutation',
      'Node',
      'Post',
      'Subscription',
      'User',
    ]);
    const g2 = buildGraph(model, types, opts({ focus: 'Comment', depth: 2 }));
    expect(g2.cards.size).toBeGreaterThan(g1.cards.size);
  });

  it('draws field edges with coverage status and implements edges', () => {
    const g = buildGraph(model, types, opts());
    const viewer = g.edges.find((e) => e.id === 'Query.f:viewer')!;
    expect(viewer).toMatchObject({
      source: 'Query',
      target: 'User',
      status: 'covered',
      kind: 'field',
    });
    expect(g.edges.find((e) => e.id === 'Query.f:post')!.status).toBe('uncovered');
    expect(
      g.edges.some((e) => e.kind === 'implements' && e.source === 'Post' && e.target === 'Content'),
    ).toBe(true);
    expect(g.edges.some((e) => e.kind === 'member' && e.source === 'SearchResult')).toBe(true);
    expect(g.cards.get('Video')!.rows.find((r) => r.name === 'title')!.status).toBe(
      'via_interface',
    );
  });

  it('limits large schemas to the root neighbourhood and collapses long field lists', () => {
    const g = buildGraph(model, types, opts({ maxNodes: 4 }));
    expect(g.limited).toBe(true);
    expect(g.cards.size).toBeLessThanOrEqual(4);
    expect(g.totalCandidates).toBeGreaterThan(4);

    const sdl = `type Query { big: Big } type Big { ${Array.from({ length: 40 }, (_, i) => `f${i}: Int`).join(' ')} }`;
    const bigModel = buildSchemaModel(buildSchema(sdl));
    const bigTypes = computeCoverage(bigModel, new CoverageAccumulator().snapshot()).types;
    const collapsed = buildGraph(bigModel, bigTypes, opts()).cards.get('Big')!;
    expect(collapsed.rows).toHaveLength(MAX_ROWS);
    expect(collapsed.hidden).toBe(40 - MAX_ROWS);
    const expanded = buildGraph(bigModel, bigTypes, opts({ expanded: new Set(['Big']) })).cards.get(
      'Big',
    )!;
    expect(expanded.rows).toHaveLength(40);
    expect(cardHeight(expanded)).toBeGreaterThan(cardHeight(collapsed));
  });

  it('"all" root shows every allowed type', () => {
    const g = buildGraph(model, types, opts({ root: 'all', showEnums: true, showInputs: true }));
    expect(g.cards.has('UpdatePostInput')).toBe(true);
    expect(g.cards.has('Subscription')).toBe(true);
  });
});
