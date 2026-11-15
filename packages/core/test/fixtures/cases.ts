/**
 * Analyzer fixtures: query + variables → exact expected coverage.
 * Every list is compared as an exact, order-insensitive set.
 */
export interface FixtureCase {
  name: string;
  query: string;
  variables?: Record<string, unknown> | undefined;
  /** Pass `null` to analyse with unknown variables (e.g. redacted log replay). */
  unknownVariables?: boolean;
  operationName?: string;
  expect: {
    status: 'valid' | 'invalid';
    operationType?: 'query' | 'mutation' | 'subscription';
    operationName?: string | null;
    errorsMatch?: RegExp;
    introspection?: boolean;
    rootFields?: string[];
    fields?: string[];
    /** coordinate → expected occurrences */
    occurrences?: Record<string, number>;
    args?: string[];
    argSources?: Record<string, string[]>;
    enumValues?: string[];
    inputFields?: string[];
    unionMembers?: string[];
    conditional?: string[];
    aliases?: Record<string, string[]>;
    paths?: Record<string, string[]>;
    fragments?: Record<string, string[]>;
    maxDepth?: number;
  };
}

const deepQuery = `
query Deep {
  me {                      # 1
    friends {               # 2
      posts {               # 3
        comments {          # 4
          replies {         # 5
            author {        # 6
              bestFriend {  # 7
                posts {     # 8
                  author {  # 9
                    friends {  # 10
                      name     # 11
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export const cases: FixtureCase[] = [
  {
    name: 'simple query with literal argument',
    query: `{ user(id: "1") { id name } }`,
    expect: {
      status: 'valid',
      operationType: 'query',
      operationName: null,
      rootFields: ['Query.user'],
      fields: ['Query.user', 'User.id', 'User.name'],
      args: ['Query.user(id:)'],
      argSources: { 'Query.user(id:)': ['literal'] },
      paths: { 'User.name': ['query.user.name'] },
      maxDepth: 2,
    },
  },
  {
    name: 'alias of the same field twice with different arguments',
    query: `{
      first: user(id: "1") { name }
      second: user(id: "2") { name nick: name }
    }`,
    expect: {
      status: 'valid',
      fields: ['Query.user', 'User.name'],
      occurrences: { 'Query.user': 2, 'User.name': 3 },
      aliases: { 'Query.user': ['first', 'second'], 'User.name': ['nick'] },
      args: ['Query.user(id:)'],
      paths: { 'User.name': ['query.user.name'] },
    },
  },
  {
    name: 'nested and reused named fragments',
    query: `
      query WithFragments {
        me { ...UserCard friends { ...UserCard } }
      }
      fragment UserCard on User { id ...UserName posts(first: 2) { ...PostBits } }
      fragment UserName on User { name }
      fragment PostBits on Post { title author { ...UserName } }
    `,
    expect: {
      status: 'valid',
      operationName: 'WithFragments',
      fields: [
        'Query.me',
        'User.friends',
        'User.id',
        'User.name',
        'User.posts',
        'Post.title',
        'Post.author',
      ],
      occurrences: { 'User.name': 4, 'User.id': 2 },
      fragments: {
        'User.name': ['UserName'],
        'User.id': ['UserCard'],
        'Post.title': ['PostBits'],
        'User.friends': [],
      },
      paths: {
        'User.name': [
          'query.me.friends.name',
          'query.me.friends.posts.author.name',
          'query.me.name',
          'query.me.posts.author.name',
        ],
      },
      args: ['User.posts(first:)'],
    },
  },
  {
    name: 'recursive-shaped fragments (same fragment at several nesting levels)',
    query: `
      query Thread {
        user(id: "1") { posts { comments { ...CommentTree } } }
      }
      fragment CommentFields on Comment { id text author { name } }
      fragment CommentTree on Comment {
        ...CommentFields
        replies { ...CommentFields replies { ...CommentFields } }
      }
    `,
    expect: {
      status: 'valid',
      fields: [
        'Query.user',
        'User.posts',
        'Post.comments',
        'Comment.id',
        'Comment.text',
        'Comment.author',
        'Comment.replies',
        'User.name',
      ],
      occurrences: { 'Comment.text': 3, 'Comment.replies': 2 },
      maxDepth: 7,
    },
  },
  {
    name: 'truly cyclic fragments are invalid and give no coverage',
    query: `
      { me { ...A } }
      fragment A on User { name ...B }
      fragment B on User { id ...A }
    `,
    expect: {
      status: 'invalid',
      errorsMatch: /Cannot spread fragment "A" within itself/,
      fields: [],
    },
  },
  {
    name: 'interface field vs concrete inline fragment',
    query: `{
      node(id: "1") {
        id
        ... on User { name }
        ... on Content { title }
      }
      feed { title author { name } ... on Post { body } ... on Video { durationSec } }
    }`,
    expect: {
      status: 'valid',
      fields: [
        'Query.node',
        'Node.id',
        'User.name',
        'Content.title',
        'Query.feed',
        'Content.author',
        'Post.body',
        'Video.durationSec',
      ],
      unionMembers: [],
    },
  },
  {
    name: 'union with inline fragments, named fragment and interface condition',
    query: `
      query Search($text: String!) {
        search(text: $text, limit: 5) {
          __typename
          ... on User { name }
          ...PostHit
          ... on Content { title }
        }
      }
      fragment PostHit on Post { body }
    `,
    variables: { text: 'graph' },
    expect: {
      status: 'valid',
      fields: ['Query.search', 'User.name', 'Post.body', 'Content.title'],
      unionMembers: ['SearchResult.User', 'SearchResult.Post', 'SearchResult.Video'],
      args: ['Query.search(text:)', 'Query.search(limit:)'],
      argSources: { 'Query.search(text:)': ['variable'], 'Query.search(limit:)': ['literal'] },
    },
  },
  {
    name: 'union selected only through one member',
    query: `{ search(text: "x") { ... on Video { durationSec } ... on SearchResult { __typename } } }`,
    expect: {
      status: 'valid',
      fields: ['Query.search', 'Video.durationSec'],
      unionMembers: ['SearchResult.Video'],
    },
  },
  {
    name: '@include / @skip evaluated from variables and literals',
    query: `
      query Cond($withEmail: Boolean!, $skipRole: Boolean!) {
        me {
          name
          email @include(if: $withEmail)
          role @skip(if: $skipRole)
          id @include(if: false)
          bestFriend @skip(if: false) { name }
          ... on User @include(if: $withEmail) { posts { title } }
          ...Friends @skip(if: true)
        }
      }
      fragment Friends on User { friends { id } }
    `,
    variables: { withEmail: false, skipRole: false },
    expect: {
      status: 'valid',
      fields: ['Query.me', 'User.name', 'User.role', 'User.bestFriend'],
      conditional: [],
    },
  },
  {
    name: '@include / @skip with unknown variables are counted as conditional',
    query: `
      query Cond($withEmail: Boolean!, $deep: Boolean! = true) {
        me {
          name
          email @include(if: $withEmail)
          friends @include(if: $deep) { id }
          ... on User @skip(if: $withEmail) { posts { title } }
          ...Role @include(if: $withEmail)
        }
      }
      fragment Role on User { role }
    `,
    unknownVariables: true,
    expect: {
      status: 'valid',
      fields: [
        'Query.me',
        'User.name',
        'User.email',
        'User.friends',
        'User.id',
        'User.posts',
        'Post.title',
        'User.role',
      ],
      conditional: [
        'User.email',
        'User.friends',
        'User.id',
        'User.posts',
        'Post.title',
        'User.role',
      ],
    },
  },
  {
    name: 'directive defaults, inline fragments without type condition and custom directives',
    query: `
      query Cond($deep: Boolean! = true, $shallow: Boolean! = false) {
        me @tag(name: "x") {
          friends @include(if: $deep) { id }
          email @include(if: $shallow)
          ... @include(if: true) @tag(name: "y") { name }
        }
      }
    `,
    expect: {
      status: 'valid',
      fields: ['Query.me', 'User.friends', 'User.id', 'User.name'],
      conditional: [],
    },
  },
  {
    name: 'unknown variables: variable-valued arguments are recorded but not inspected',
    query: `query($id: ID!, $f: PostFilter) { user(id: $id) { name } posts(filter: $f) { id } }`,
    unknownVariables: true,
    expect: {
      status: 'valid',
      args: ['Query.user(id:)', 'Query.posts(filter:)'],
      inputFields: [],
      argSources: { 'Query.posts(filter:)': ['variable'] },
    },
  },
  {
    name: 'variables with nested input objects, lists and enums',
    query: `
      query Posts($filter: PostFilter, $order: PostOrder!) {
        posts(filter: $filter, order: $order) { id status }
      }
    `,
    variables: {
      filter: {
        authorId: null,
        status: ['PUBLISHED', 'ARCHIVED'],
        and: [{ tags: ['a'] }, { and: { authorId: '7' } }],
      },
      order: { field: 'TITLE' },
    },
    expect: {
      status: 'valid',
      fields: ['Query.posts', 'Post.id', 'Post.status'],
      args: ['Query.posts(filter:)', 'Query.posts(order:)'],
      inputFields: [
        'PostFilter.status',
        'PostFilter.and',
        'PostFilter.tags',
        'PostFilter.authorId',
        'PostOrder.field',
      ],
      enumValues: ['PostStatus.PUBLISHED', 'PostStatus.ARCHIVED', 'PostOrderField.TITLE'],
      occurrences: { 'Query.posts': 1 },
    },
  },
  {
    name: 'input literals with nested variables, single-item list coercion and variable defaults',
    query: `
      query Posts($status: PostStatus = DRAFT, $dir: SortDirection, $missing: ID) {
        posts(
          filter: { status: [$status], and: { tags: "solo", authorId: $missing }, authorId: null }
          order: { field: CREATED_AT, direction: $dir }
        ) { id }
      }
    `,
    variables: { dir: 'DESC' },
    expect: {
      status: 'valid',
      fields: ['Query.posts', 'Post.id'],
      inputFields: [
        'PostFilter.status',
        'PostFilter.and',
        'PostFilter.tags',
        'PostFilter.authorId',
        'PostOrder.field',
        'PostOrder.direction',
      ],
      enumValues: ['PostStatus.DRAFT', 'PostOrderField.CREATED_AT', 'SortDirection.DESC'],
    },
  },
  {
    name: 'several operations in a document + operationName',
    query: `
      query A { me { id } }
      query B { user(id: "1") { name } }
      mutation C { deletePost(id: "1") }
    `,
    operationName: 'B',
    expect: {
      status: 'valid',
      operationType: 'query',
      operationName: 'B',
      fields: ['Query.user', 'User.name'],
    },
  },
  {
    name: 'several operations without operationName are rejected like graphql-js does',
    query: `query A { me { id } } query B { me { name } }`,
    expect: {
      status: 'invalid',
      errorsMatch: /Must provide operation name/,
      fields: [],
    },
  },
  {
    name: 'unknown operationName',
    query: `query A { me { id } }`,
    operationName: 'Nope',
    expect: { status: 'invalid', errorsMatch: /Unknown operation named "Nope"/, fields: [] },
  },
  {
    name: 'document without operations',
    query: `fragment F on User { id }`,
    expect: { status: 'invalid', errorsMatch: /Must provide an operation|never used/, fields: [] },
  },
  {
    name: '__typename and client introspection are not counted',
    query: `{
      __typename
      __schema { types { name } }
      __type(name: "User") { name fields { name } }
      me { __typename id }
    }`,
    expect: {
      status: 'valid',
      introspection: true,
      rootFields: ['Query.me'],
      fields: ['Query.me', 'User.id'],
    },
  },
  {
    name: 'pure introspection query',
    query: `query IntrospectionQuery { __schema { queryType { name } } }`,
    expect: { status: 'valid', introspection: true, rootFields: [], fields: [] },
  },
  {
    name: 'invalid query: unknown field',
    query: `{ me { id nope } }`,
    expect: {
      status: 'invalid',
      operationType: 'query',
      errorsMatch: /Cannot query field "nope" on type "User"/,
      fields: [],
    },
  },
  {
    name: 'invalid query: syntax error',
    query: `{ me { id `,
    expect: { status: 'invalid', errorsMatch: /Syntax Error/, fields: [] },
  },
  {
    name: 'invalid variables: wrong enum value',
    query: `query($s: PostStatus!) { posts(filter: { status: [$s] }) { id } }`,
    variables: { s: 'NOT_A_STATUS' },
    expect: { status: 'invalid', errorsMatch: /Value "NOT_A_STATUS" does not exist/, fields: [] },
  },
  {
    name: 'mutation with input argument (variable + defaults)',
    query: `
      mutation Create($input: CreatePostInput!) {
        createPost(input: $input) { id status author { name } }
        updateRole(userId: "1", role: EDITOR) { role }
      }
    `,
    variables: {
      input: { title: 't', body: 'b', meta: { priority: 1 }, status: 'PUBLISHED' },
    },
    expect: {
      status: 'valid',
      operationType: 'mutation',
      rootFields: ['Mutation.createPost', 'Mutation.updateRole'],
      fields: [
        'Mutation.createPost',
        'Mutation.updateRole',
        'Post.id',
        'Post.status',
        'Post.author',
        'User.name',
        'User.role',
      ],
      args: [
        'Mutation.createPost(input:)',
        'Mutation.updateRole(userId:)',
        'Mutation.updateRole(role:)',
      ],
      inputFields: [
        'CreatePostInput.title',
        'CreatePostInput.body',
        'CreatePostInput.meta',
        'CreatePostInput.status',
        'PostMetaInput.priority',
      ],
      enumValues: ['PostStatus.PUBLISHED', 'Role.EDITOR'],
    },
  },
  {
    name: 'subscription',
    query: `subscription OnPost { postAdded(status: PUBLISHED) { id title } }`,
    expect: {
      status: 'valid',
      operationType: 'subscription',
      rootFields: ['Subscription.postAdded'],
      fields: ['Subscription.postAdded', 'Post.id', 'Post.title'],
      enumValues: ['PostStatus.PUBLISHED'],
    },
  },
  {
    name: 'query of depth 11',
    query: deepQuery,
    expect: {
      status: 'valid',
      maxDepth: 11,
      fields: [
        'Query.me',
        'User.friends',
        'User.posts',
        'Post.comments',
        'Comment.replies',
        'Comment.author',
        'User.bestFriend',
        'Post.author',
        'User.name',
      ],
      paths: {
        'User.name': [
          'query.me.friends.posts.comments.replies.author.bestFriend.posts.author.friends.name',
        ],
      },
    },
  },
];
