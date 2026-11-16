import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  CoverageAccumulator,
  analyzeRequest,
  buildSchemaModel,
  computeCoverage,
  insights,
} from '../src/index.js';

const schema = buildSchema(`
  type User { id: ID!, name: String, nick: String @deprecated(reason: "use name"), posts(first: Int, after: String): [Post!]! }
  type Post { id: ID!, title: String }
  type Orphan { x: Int }
  type Query { me: User, legacy: String @deprecated, orphan: Orphan }
  type Mutation { rename(name: String!): User, remove(id: ID!): Boolean }
  type Subscription { renamed: User }
`);
const model = buildSchemaModel(schema);

describe('insights', () => {
  it('flags deprecated fields in use, untested writes, conditional and untouched parts', () => {
    const acc = new CoverageAccumulator();
    const add = (query: string, variablesKnown = true) =>
      acc.add(analyzeRequest(schema, { query }, { variablesKnown }));
    add('{ me { id nick posts(first: 2) { id } } legacy }');
    add('{ me { nick } }');
    add('query($s: Boolean!) { me { name @include(if: $s) } }', false);
    add('mutation { rename(name: "x") { id } }');
    const r = insights(model, computeCoverage(model, acc.snapshot()));
    expect(r.deprecatedInUse).toEqual([
      { coordinate: 'User.nick', requests: 2 },
      { coordinate: 'Query.legacy', requests: 1 },
    ]);
    expect(r.untestedMutations).toEqual(['Mutation.remove']);
    expect(r.untestedSubscriptions).toEqual(['Subscription.renamed']);
    expect(r.conditionalOnly).toEqual(['User.name']);
    expect(r.untouchedTypes).toEqual(['Orphan']);
    expect(r.unusedArguments).toEqual(['User.posts(after:)']);
  });

  it('skips non-object types and orders deprecated fields with equal use by name', () => {
    const s2 = buildSchema(`
      enum Kind { A B }
      union U = Q2
      type Q2 { b: Int @deprecated, a: Int @deprecated, k: Kind, u: U }
      schema { query: Q2 }
    `);
    const m2 = buildSchemaModel(s2);
    const acc = new CoverageAccumulator();
    acc.add(analyzeRequest(s2, { query: '{ b a }' }));
    const r = insights(m2, computeCoverage(m2, acc.snapshot()));
    expect(r.deprecatedInUse.map((d) => d.coordinate)).toEqual(['Q2.a', 'Q2.b']);
    expect(r.untestedMutations).toEqual([]);
  });
});
