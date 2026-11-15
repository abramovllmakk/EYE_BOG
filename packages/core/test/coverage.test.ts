import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  CoverageAccumulator,
  analyzeRequest,
  buildSchemaModel,
  computeCoverage,
  coverageFromAnalysis,
  emptyCoverageData,
  fieldsByTest,
  mergeCoverageData,
  parseTestKey,
  ratio,
  testKey,
  MAX_PATHS,
} from '../src/index.js';

const schema = buildSchema(
  readFileSync(new URL('./fixtures/schema.graphql', import.meta.url), 'utf8'),
);
const model = buildSchemaModel(schema);

function run(
  queries: { query: string; variables?: Record<string, unknown>; test?: string; suite?: string }[],
) {
  const acc = new CoverageAccumulator();
  for (const q of queries) {
    acc.add(analyzeRequest(schema, { query: q.query, variables: q.variables ?? null }), {
      name: q.test,
      suite: q.suite,
    });
  }
  return acc;
}

describe('test keys', () => {
  it('formats and parses suite::name', () => {
    expect(testKey(undefined)).toBe('unknown');
    expect(testKey({ name: '  ' })).toBe('unknown');
    expect(testKey({ name: 'login' })).toBe('login');
    expect(testKey({ name: 'login', suite: 'auth' })).toBe('auth::login');
    expect(parseTestKey('auth::login')).toEqual({ suite: 'auth', name: 'login' });
    expect(parseTestKey('login')).toEqual({ suite: null, name: 'login' });
  });
});

describe('ratio', () => {
  it('rounds to one decimal and treats empty totals as 100%', () => {
    expect(ratio(1, 3)).toEqual({ covered: 1, total: 3, percent: 33.3 });
    expect(ratio(0, 0).percent).toBe(100);
  });
});

describe('accumulator', () => {
  it('counts requests vs occurrences and tests per field', () => {
    const acc = run([
      { query: '{ a: me { name } b: me { name } }', test: 't1', suite: 's' },
      { query: '{ me { name id } }', test: 't2' },
      { query: '{ me { nope } }', test: 't3' },
    ]);
    const d = acc.snapshot();
    expect(d.requests).toEqual({ total: 3, valid: 2, invalid: 1, introspection: 0, unresolved: 0 });
    expect(d.fields['User.name']).toMatchObject({
      requests: 2,
      occurrences: 3,
      tests: { 's::t1': 1, t2: 1 },
    });
    expect(d.fields['Query.me']!.aliases).toEqual(['a', 'b']);
    expect(Object.keys(d.tests).sort()).toEqual(['s::t1', 't2']);
    expect(fieldsByTest(d)['t2']).toEqual(['Query.me', 'User.id', 'User.name']);
  });

  it('drains for write-behind flushing and tracks unresolved APQ', () => {
    const acc = run([{ query: '{ me { id } }' }]);
    acc.addUnresolved();
    expect(acc.isEmpty).toBe(false);
    const d = acc.drain();
    expect(d.requests.unresolved).toBe(1);
    expect(d.requests.total).toBe(2);
    expect(acc.isEmpty).toBe(true);
    acc.addUnresolved();
    acc.correctUnresolved();
    expect(acc.snapshot().requests).toMatchObject({ total: 0, unresolved: 0 });
  });

  it('merges field details (depth, conditional, aliases, args, enums, paths cap)', () => {
    const a = coverageFromAnalysis(
      analyzeRequest(
        schema,
        { query: 'query($e: Boolean!) { me { x: email @include(if: $e) } }' },
        { variablesKnown: false },
      ),
    );
    const b = coverageFromAnalysis(
      analyzeRequest(schema, {
        query: 'mutation { updateRole(userId: "1", role: ADMIN) { bestFriend { email } } }',
      }),
      { name: 'm' },
    );
    const c = coverageFromAnalysis(
      analyzeRequest(schema, {
        query:
          'query($id: ID!) { search(text: "a") { ... on User { id } } updateRoleLike: user(id: $id) { role } }',
        variables: { id: '1' },
      }),
    );
    const merged = mergeCoverageData(
      mergeCoverageData(mergeCoverageData(emptyCoverageData(), a), b),
      b,
    );
    mergeCoverageData(merged, c);
    expect(merged.fields['User.email']).toMatchObject({
      requests: 3,
      minDepth: 2,
      maxDepth: 3,
      conditionalOnly: false,
      aliases: ['x'],
    });
    expect(merged.arguments['Mutation.updateRole(role:)']).toMatchObject({
      requests: 2,
      sources: ['literal'],
    });
    expect(merged.arguments['Query.user(id:)']!.sources).toEqual(['variable']);
    expect(merged.enumValues['Role.ADMIN']).toEqual({ requests: 2, occurrences: 2 });
    expect(merged.unionMembers['SearchResult.User']).toEqual({ requests: 1, occurrences: 1 });

    const wide = emptyCoverageData();
    const paths = Object.fromEntries(Array.from({ length: MAX_PATHS + 5 }, (_, i) => [`p${i}`, 1]));
    const fieldHit = {
      requests: 1,
      occurrences: 1,
      minDepth: 1,
      maxDepth: 1,
      conditionalOnly: false,
      aliases: [],
      fragments: ['F'],
      paths: {},
      tests: {},
    };
    mergeCoverageData(wide, { ...emptyCoverageData(), fields: { 'Query.me': { ...fieldHit } } });
    mergeCoverageData(wide, {
      ...emptyCoverageData(),
      fields: { 'Query.me': { ...fieldHit, paths, fragments: ['G'] } },
    });
    mergeCoverageData(wide, {
      ...emptyCoverageData(),
      fields: { 'Query.me': { ...fieldHit, paths: { p0: 2 } } },
    });
    expect(Object.keys(wide.fields['Query.me']!.paths)).toHaveLength(MAX_PATHS);
    expect(wide.fields['Query.me']!.paths['p0']).toBe(3);
    expect(wide.fields['Query.me']!.fragments).toEqual(['F', 'G']);
  });

  it('caps the alias list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `a${i}: me { id }`).join(' ');
    const d = run([
      { query: `{ ${many} }` },
      { query: `{ ${many.replaceAll(': me', 'x: me')} }` },
    ]).snapshot();
    expect(d.fields['Query.me']!.aliases).toHaveLength(25);
  });

  it('counts introspection requests', () => {
    const acc = run([{ query: '{ __schema { queryType { name } } }' }]);
    expect(acc.snapshot().requests.introspection).toBe(1);
  });
});

describe('computeCoverage', () => {
  const acc = run([
    { query: '{ me { id name role posts(first: 1) { title } } }', test: 'profile' },
    { query: '{ feed { title } search(text: "x") { ... on Video { id } } }', test: 'feed' },
    {
      query: 'query($f: PostFilter) { posts(filter: $f) { id } }',
      variables: { f: { status: ['DRAFT'] } },
      test: 'filter',
    },
    { query: 'subscription { postAdded { id } }' },
  ]);
  const data = acc.snapshot();

  it('classifies object types and fields', () => {
    const report = computeCoverage(model, data);
    const user = report.types.find((t) => t.name === 'User')!;
    expect(user.status).toBe('partial');
    expect(user.ratio).toEqual({ covered: 4, total: 7, percent: 57.1 });
    const posts = user.fields.find((f) => f.name === 'posts')!;
    expect(posts).toMatchObject({ status: 'covered', requests: 1, tests: 1 });
    expect(posts.args.map((a) => [a.name, a.used])).toEqual([
      ['first', true],
      ['after', false],
      ['orderBy', false],
    ]);
    expect(report.types.find((t) => t.name === 'Comment')!.status).toBe('uncovered');
    expect(report.types.some((t) => t.kind === 'SCALAR')).toBe(false);
  });

  it('marks implementation fields covered through an interface', () => {
    const report = computeCoverage(model, data);
    const video = report.types.find((t) => t.name === 'Video')!;
    expect(video.fields.find((f) => f.name === 'title')).toMatchObject({
      status: 'via_interface',
      counted: false,
      viaInterfaces: ['Content'],
    });
    expect(video.fields.find((f) => f.name === 'id')!.status).toBe('covered');
    const propagated = computeCoverage(model, data, { propagateInterfaceCoverage: true });
    expect(
      propagated.types.find((t) => t.name === 'Video')!.fields.find((f) => f.name === 'title')!
        .counted,
    ).toBe(true);
    expect(propagated.summary.fields.covered).toBeGreaterThan(report.summary.fields.covered);
  });

  it('computes union, enum, input and operation ratios', () => {
    const report = computeCoverage(model, data);
    const byName = (n: string) => report.types.find((t) => t.name === n)!;
    expect(byName('SearchResult')).toMatchObject({
      status: 'partial',
      ratio: { covered: 1, total: 3 },
    });
    expect(
      byName('PostStatus')
        .values.filter((v) => v.used)
        .map((v) => v.name),
    ).toEqual(['DRAFT']);
    expect(byName('PostFilter').ratio).toEqual({ covered: 1, total: 4, percent: 25 });
    expect(byName('Role').status).toBe('uncovered');
    const s = report.summary;
    expect(s.operations.query).toEqual({ covered: 4, total: 6, percent: 66.7 });
    expect(s.operations.mutation).toEqual({ covered: 0, total: 3, percent: 0 });
    expect(s.operations.subscription).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(s.operations.covered).toBe(5);
    expect(report.uncovered.operations).toContain('Mutation.createPost');
    expect(report.uncovered.enumValues).toContain('Role.ADMIN');
    expect(report.uncovered.inputFields).toContain('PostFilter.and');
    expect(report.uncovered.arguments).toContain('User.posts(after:)');
    expect(report.uncovered.types).toContain('Comment');
    expect(s.tests).toBe(4);
    expect(s.maxDepth).toBe(3);
    expect(s.depth[0]).toEqual({ depth: 1, fields: 5 });
    expect(s.edges.total).toBeGreaterThan(s.edges.covered);
    expect(s.types.fullyCovered).toBe(0);
  });

  it('reports a fully covered type', () => {
    const full = run([
      {
        query:
          'mutation { createPost(input: { title: "t", body: "b", tags: [], status: DRAFT, meta: { seoTitle: "s", priority: 1 } }) { id } }',
      },
    ]);
    const report = computeCoverage(model, full.snapshot());
    expect(report.types.find((t) => t.name === 'CreatePostInput')!.status).toBe('covered');
    expect(report.types.find((t) => t.name === 'PostMetaInput')!.status).toBe('covered');
    expect(report.summary.types.fullyCovered).toBe(2);
  });

  it('handles schemas without a query root', () => {
    const noQuery = buildSchemaModel(buildSchema('schema { mutation: M } type M { a: Int }'));
    expect(noQuery.roots).toEqual({ query: null, mutation: 'M', subscription: null });
  });

  it('handles schemas without mutation/subscription roots', () => {
    const tiny = buildSchemaModel(buildSchema('type Query { a: Int }'));
    const report = computeCoverage(tiny, emptyCoverageData());
    expect(report.summary.operations).toMatchObject({ covered: 0, total: 1 });
    expect(report.summary.operations.mutation.percent).toBe(100);
    expect(report.summary.maxDepth).toBe(0);
  });
});
