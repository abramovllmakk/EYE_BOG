import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  CoverageAccumulator,
  analyzeRequest,
  buildSchemaModel,
  computeCoverage,
  emptyCoverageData,
  testImpact,
} from '../src/index.js';

const schema = buildSchema(
  readFileSync(new URL('./fixtures/schema.graphql', import.meta.url), 'utf8'),
);
const model = buildSchemaModel(schema);

function impact(tests: { name?: string; suite?: string; query: string }[]) {
  const acc = new CoverageAccumulator();
  for (const t of tests) acc.add(analyzeRequest(schema, { query: t.query }), t);
  const data = acc.snapshot();
  return testImpact(data, computeCoverage(model, data));
}

describe('testImpact', () => {
  const r = impact([
    { name: 'profile', suite: 'users', query: '{ me { id name email } }' },
    { name: 'name only', suite: 'users', query: '{ me { name } }' },
    { name: 'feed', query: '{ feed { id title } }' },
    { name: 'typename only', query: '{ __typename }' },
    { query: '{ me { role } }' },
  ]);
  const t = (k: string) => r.tests.find((x) => x.testKey === k)!;

  it('finds unique, shared, redundant and empty tests', () => {
    expect(t('users::profile')).toMatchObject({
      suite: 'users',
      name: 'profile',
      fields: 4,
      unique: ['User.email', 'User.id'],
      shared: 2,
      redundant: false,
      requests: 1,
    });
    expect(t('users::name only')).toMatchObject({ fields: 2, unique: [], redundant: true });
    expect(t('typename only')).toMatchObject({
      fields: 0,
      empty: true,
      redundant: false,
      minimalRank: null,
    });
    expect(t('unknown')).toMatchObject({ unnamed: true, unique: ['User.role'] });
    expect(r.redundant).toBe(1);
    expect(r.empty).toBe(1);
  });

  it('builds a minimal set that keeps the same coverage', () => {
    expect(r.minimalSet.testKeys).toEqual(['users::profile', 'feed', 'unknown']);
    expect(r.minimalSet.cumulative).toEqual([4, 7, 8]);
    expect(r.coveredFields).toBe(8);
    expect(r.totalFields).toBe(computeCoverage(model, emptyCoverageData()).summary.fields.total);
    expect(t('users::name only').minimalRank).toBeNull();
  });

  it('orders by unique contribution', () => {
    expect(r.tests.map((x) => x.testKey)).toEqual([
      'feed',
      'users::profile',
      'unknown',
      'users::name only',
      'typename only',
    ]);
  });

  it('ignores fields outside the schema and tolerates tests missing from counters', () => {
    const data = emptyCoverageData();
    data.fields['Gone.x'] = {
      requests: 1,
      occurrences: 1,
      minDepth: 1,
      maxDepth: 1,
      conditionalOnly: false,
      aliases: [],
      fragments: [],
      paths: {},
      tests: { ghost: 1 },
    };
    data.fields['Query.me'] = { ...data.fields['Gone.x'], tests: { ghost: 1 } };
    const res = testImpact(data, computeCoverage(model, data));
    expect(res.tests).toEqual([
      expect.objectContaining({ testKey: 'ghost', requests: 0, fields: 1, unique: ['Query.me'] }),
    ]);
  });

  it('breaks ties by test key', () => {
    const tie = impact([
      { name: 'b', query: '{ me { name } }' },
      { name: 'a', query: '{ me { name } }' },
    ]);
    expect(tie.tests.map((x) => x.testKey)).toEqual(['a', 'b']);
    expect(tie.minimalSet.testKeys).toEqual(['a']);
  });
});
