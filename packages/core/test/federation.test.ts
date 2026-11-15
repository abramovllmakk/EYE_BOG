import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  CoverageAccumulator,
  analyzeRequest,
  buildSchemaModel,
  computeCoverage,
} from '../src/index.js';

const schema = buildSchema(
  readFileSync(new URL('./fixtures/supergraph.graphql', import.meta.url), 'utf8'),
);
const model = buildSchemaModel(schema);
const field = (c: string) => {
  const [t, f] = c.split('.');
  return model.types.find((x) => x.name === t)!.fields.find((x) => x.name === f)!;
};

describe('federation supergraph', () => {
  it('lists subgraphs and hides join__/link__ internals', () => {
    expect(model.services).toEqual(['accounts', 'legacy', 'products', 'reviews']);
    expect(
      model.types.some((t) => t.name.startsWith('join__') || t.name.startsWith('link__')),
    ).toBe(false);
    expect(model.types.find((t) => t.name === 'User')!.services).toEqual(['accounts', 'reviews']);
  });

  it('assigns each field to its owning subgraph(s)', () => {
    expect(field('Query.me').services).toEqual(['accounts']);
    expect(field('Query.topProducts').services).toEqual(['products']);
    expect(field('User.name').services).toEqual(['accounts']);
    expect(field('User.id').services).toEqual(['accounts', 'reviews']); // key field: every type owner
    expect(field('Product.price').services).toEqual(['products']); // external in reviews is not ownership
    expect(field('Review.body').services).toEqual(['reviews']);
    expect(field('Legacy.x').services).toEqual([]); // @join__field without graph
    expect(field('Legacy.y').services).toEqual(['ghost', 'legacy']); // unknown enum value is lower-cased
  });

  it('computes field coverage per subgraph', () => {
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(schema, { query: '{ me { id name } topProducts { upc name } }' }));
    const s = computeCoverage(model, acc.snapshot()).summary.services;
    expect(s).toEqual([
      { service: 'accounts', fields: { covered: 3, total: 3, percent: 100 } },
      { service: 'ghost', fields: { covered: 0, total: 1, percent: 0 } },
      { service: 'legacy', fields: { covered: 0, total: 1, percent: 0 } },
      { service: 'products', fields: { covered: 3, total: 4, percent: 75 } },
      { service: 'reviews', fields: { covered: 2, total: 7, percent: 28.6 } }, // User.id, Product.upc (keys)
    ]);
  });

  it('non-federated schemas have no services', () => {
    const plain = buildSchemaModel(buildSchema('type Query { a: Int }'));
    expect(plain.services).toEqual([]);
    expect(plain.types.find((t) => t.name === 'Query')!.fields[0]!.services).toEqual([]);
  });
});
