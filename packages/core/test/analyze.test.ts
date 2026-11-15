import { readFileSync } from 'node:fs';
import { Kind, OperationTypeNode, buildSchema, type DocumentNode } from 'graphql';
import { describe, expect, it } from 'vitest';
import { analyzeRequest, prepareDocument, analyzePrepared } from '../src/index.js';
import { cases } from './fixtures/cases.js';

const schema = buildSchema(
  readFileSync(new URL('./fixtures/schema.graphql', import.meta.url), 'utf8'),
);

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('analyzer fixtures', () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = analyzeRequest(
        schema,
        { query: c.query, operationName: c.operationName ?? null, variables: c.variables ?? null },
        { variablesKnown: !c.unknownVariables },
      );
      const e = c.expect;
      expect(result.status, JSON.stringify(result.errors)).toBe(e.status);
      if (e.errorsMatch) expect(result.errors.join('\n')).toMatch(e.errorsMatch);
      if (e.status === 'valid') expect(result.errors).toEqual([]);
      if (e.operationType) expect(result.operationType).toBe(e.operationType);
      if (e.operationName !== undefined) expect(result.operationName).toBe(e.operationName);
      if (e.introspection !== undefined) expect(result.introspection).toBe(e.introspection);
      if (e.rootFields) expect(sorted(result.rootFields)).toEqual(sorted(e.rootFields));
      if (e.fields)
        expect(sorted(result.fields.map((f) => f.coordinate))).toEqual(sorted(e.fields));
      const byCoord = new Map(result.fields.map((f) => [f.coordinate, f]));
      for (const [coord, n] of Object.entries(e.occurrences ?? {})) {
        expect(byCoord.get(coord)?.occurrences, coord).toBe(n);
      }
      for (const [coord, aliases] of Object.entries(e.aliases ?? {})) {
        expect(byCoord.get(coord)?.aliases, coord).toEqual(sorted(aliases));
      }
      for (const [coord, paths] of Object.entries(e.paths ?? {})) {
        expect(byCoord.get(coord)?.paths, coord).toEqual(sorted(paths));
      }
      for (const [coord, frags] of Object.entries(e.fragments ?? {})) {
        expect(byCoord.get(coord)?.fragments, coord).toEqual(sorted(frags));
      }
      if (e.conditional) {
        expect(sorted(result.fields.filter((f) => f.conditional).map((f) => f.coordinate))).toEqual(
          sorted(e.conditional),
        );
      }
      if (e.args) expect(sorted(result.arguments.map((a) => a.coordinate))).toEqual(sorted(e.args));
      for (const [coord, sources] of Object.entries(e.argSources ?? {})) {
        expect(result.arguments.find((a) => a.coordinate === coord)?.sources, coord).toEqual(
          sorted(sources),
        );
      }
      if (e.enumValues) {
        expect(sorted(result.enumValues.map((x) => x.coordinate))).toEqual(sorted(e.enumValues));
      }
      if (e.inputFields) {
        expect(sorted(result.inputFields.map((x) => x.coordinate))).toEqual(sorted(e.inputFields));
      }
      if (e.unionMembers) {
        expect(sorted(result.unionMembers.map((x) => x.coordinate))).toEqual(
          sorted(e.unionMembers),
        );
      }
      if (e.maxDepth !== undefined) expect(result.maxDepth).toBe(e.maxDepth);
    });
  }
});

describe('analyzer result shape', () => {
  it('is deterministic and JSON-serialisable', () => {
    const req = {
      query: `{ b: user(id: "2") { name } a: user(id: "1") { id name } search(text: "q") { ... on Post { id } } }`,
    };
    const r1 = analyzeRequest(schema, req);
    const r2 = analyzeRequest(schema, req);
    expect(JSON.parse(JSON.stringify(r1))).toEqual(r2);
    expect(r1.fields.map((f) => f.coordinate)).toEqual(
      [...r1.fields.map((f) => f.coordinate)].sort(),
    );
    expect(r1.depthHistogram).toEqual([
      { depth: 1, fields: 2 },
      { depth: 2, fields: 3 },
    ]);
  });

  it('lists the types a request used (fields, enums, inputs, unions)', () => {
    const r = analyzeRequest(schema, {
      query:
        'query($f: PostFilter) { me { id name } posts(filter: $f) { id } search(text: "q") { ... on Video { id } } }',
      variables: { f: { status: ['DRAFT'] } },
    });
    expect(r.types).toEqual([
      { coordinate: 'Post', occurrences: 1 },
      { coordinate: 'PostFilter', occurrences: 1 },
      { coordinate: 'PostStatus', occurrences: 1 },
      { coordinate: 'Query', occurrences: 3 },
      { coordinate: 'SearchResult', occurrences: 1 },
      { coordinate: 'User', occurrences: 2 },
      { coordinate: 'Video', occurrences: 1 },
    ]);
  });

  it('records the composite edge target and depth range of each field', () => {
    const r = analyzeRequest(schema, { query: `{ me { name bestFriend { name } } }` });
    const name = r.fields.find((f) => f.coordinate === 'User.name')!;
    expect(name).toMatchObject({
      parentType: 'User',
      fieldName: 'name',
      returnType: 'String',
      minDepth: 2,
      maxDepth: 3,
    });
    expect(r.edges).toEqual([
      { from: 'Query', field: 'me', to: 'User' },
      { from: 'User', field: 'bestFriend', to: 'User' },
    ]);
  });

  it('reuses a prepared document across variable sets', () => {
    const prepared = prepareDocument(
      schema,
      `query($e: Boolean!) { me { name email @include(if: $e) } }`,
    );
    expect(prepared.normalizedQuery).toContain('@include(if: $e)');
    const on = analyzePrepared(schema, prepared, { variables: { e: true } });
    const off = analyzePrepared(schema, prepared, { variables: { e: false } });
    expect(on.fields.map((f) => f.coordinate)).toContain('User.email');
    expect(off.fields.map((f) => f.coordinate)).not.toContain('User.email');
  });

  it('accepts programmatically built documents without optional AST arrays', () => {
    const name = (value: string) => ({ kind: Kind.NAME, value }) as const;
    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation: OperationTypeNode.QUERY,
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [
              {
                kind: Kind.FIELD,
                name: name('me'),
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  selections: [{ kind: Kind.FIELD, name: name('id') }],
                },
              },
            ],
          },
        },
      ],
    };
    const r = analyzePrepared(schema, { document, normalizedQuery: null, errors: [] });
    expect(r.fields.map((f) => f.coordinate)).toEqual(['Query.me', 'User.id']);
  });

  it('treats a missing query as invalid', () => {
    const r = analyzeRequest(schema, {});
    expect(r.status).toBe('invalid');
    expect(r.errors[0]).toMatch(/Must provide query string/);
  });

  it('counts mutation operations once per root field even with aliases', () => {
    const r = analyzeRequest(schema, {
      query: `mutation { a: deletePost(id: "1") b: deletePost(id: "2") }`,
    });
    expect(r.rootFields).toEqual(['Mutation.deletePost']);
    expect(r.fields[0]).toMatchObject({ coordinate: 'Mutation.deletePost', occurrences: 2 });
    expect(r.arguments).toEqual([
      { coordinate: 'Mutation.deletePost(id:)', occurrences: 2, sources: ['literal'] },
    ]);
  });
});
