import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchemaModel, diffSchemaModels, normalizeSdl } from '../src/index.js';

const sdl = readFileSync(new URL('./fixtures/schema.graphql', import.meta.url), 'utf8');
const schema = buildSchema(sdl);

describe('schema model', () => {
  const model = buildSchemaModel(schema);
  const t = (n: string) => model.types.find((x) => x.name === n)!;

  it('captures roots and all type kinds without introspection types', () => {
    expect(model.roots).toEqual({
      query: 'Query',
      mutation: 'Mutation',
      subscription: 'Subscription',
    });
    expect(model.types.some((x) => x.name.startsWith('__'))).toBe(false);
    expect(t('User').kind).toBe('OBJECT');
    expect(t('Node').kind).toBe('INTERFACE');
    expect(t('SearchResult').kind).toBe('UNION');
    expect(t('Role').kind).toBe('ENUM');
    expect(t('PostFilter').kind).toBe('INPUT_OBJECT');
    expect(t('String')).toMatchObject({ kind: 'SCALAR', builtIn: true });
    expect(t('User').description).toBeNull();
    expect(t('Node').description).toMatch(/Fixture schema/);
  });

  it('builds fields with unwrapped return types and arguments', () => {
    const posts = t('User').fields.find((f) => f.name === 'posts')!;
    expect(posts).toMatchObject({
      coordinate: 'User.posts',
      type: '[Post!]!',
      namedType: 'Post',
      namedTypeKind: 'OBJECT',
      deprecated: false,
    });
    expect(posts.args.map((a) => a.coordinate)).toEqual([
      'User.posts(first:)',
      'User.posts(after:)',
      'User.posts(orderBy:)',
    ]);
    expect(posts.args[2]).toMatchObject({ type: 'PostOrder', namedType: 'PostOrder' });
  });

  it('builds implements / member / field edges and possible types', () => {
    expect(t('Content').interfaces).toEqual(['Node']);
    expect(t('Node').possibleTypes).toEqual(['Comment', 'Post', 'User', 'Video']);
    expect(t('SearchResult').possibleTypes).toEqual(['Post', 'User', 'Video']);
    expect(t('PostStatus').enumValues).toEqual(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
    expect(t('CreatePostInput').inputFields.map((f) => f.namedType)).toEqual([
      'String',
      'String',
      'String',
      'PostStatus',
      'PostMetaInput',
    ]);
    const ids = model.edges.map((e) => e.id);
    expect(ids).toContain('Post>Content');
    expect(ids).toContain('SearchResult|Video');
    expect(ids).toContain('User.bestFriend');
    expect(ids).toContain('PostFilter.and');
  });

  it('normalises SDL deterministically regardless of definition order', () => {
    const reordered = buildSchema(sdl.split('\n\n').reverse().join('\n\n'));
    expect(normalizeSdl(reordered)).toBe(normalizeSdl(schema));
  });

  it('diffs two schema versions', () => {
    const next = buildSchemaModel(
      buildSchema(
        sdl
          .replace('  email: String\n', '')
          .replace('  VIEWER\n', '  VIEWER\n  GUEST\n')
          .replace(
            'type Query {',
            '"Deprecated test"\ntype Tag { name: String @deprecated(reason: "x") }\ntype Query {\n  tags: [Tag!]!',
          ),
      ),
    );
    const diff = diffSchemaModels(model, next);
    expect(diff.addedTypes).toEqual(['Tag']);
    expect(diff.removedTypes).toEqual([]);
    expect(diff.added).toEqual(['Query.tags', 'Role.GUEST', 'Tag.name']);
    expect(diff.removed).toEqual(['User.email']);
    expect(next.types.find((x) => x.name === 'Tag')!.fields[0]!.deprecated).toBe(true);
    expect(next.types.find((x) => x.name === 'Tag')!.description).toBe('Deprecated test');
  });
});
