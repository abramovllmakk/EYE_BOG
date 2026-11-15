/**
 * Demo test-suite. Each entry is one "autotest": it sends requests exactly like a real test would.
 * The expected coverage of this suite is written by hand in ../expected-coverage.json.
 */
export const tests = [
  {
    suite: 'profile',
    name: 'viewer profile',
    body: {
      query:
        '{ viewer { id name email role bio avatarUrl(size: 128) stats { postCount followerCount } } }',
    },
  },
  {
    suite: 'profile',
    name: 'user by id with posts',
    body: {
      query:
        'query UserPosts($id: ID!, $status: PostStatus) { user(id: $id) { name posts(first: 5, status: $status) { id title status likes } } }',
      variables: { id: 'u2', status: 'PUBLISHED' },
    },
  },
  {
    suite: 'profile',
    name: 'followers',
    body: { query: '{ viewer { followers(first: 3) { name following { id } } } }' },
  },
  {
    suite: 'content',
    name: 'feed',
    body: {
      query:
        '{ feed(first: 5) { __typename id title publishedAt author { name } tags { name } ... on Post { body(format: HTML) } ... on Video { durationSec resolution } } }',
    },
  },
  {
    suite: 'content',
    name: 'post with comments',
    body: {
      query: `query Post($id: ID!) {
  post(id: $id) {
    ...PostCard
    comments(first: 2, order: OLDEST) {
      totalCount
      edges { cursor node { ...CommentBits replies { ...CommentBits } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
fragment PostCard on Post { id title author { id name } }
fragment CommentBits on Comment { id text createdAt author { name } }`,
      variables: { id: 'p1' },
      operationName: 'Post',
    },
  },
  {
    suite: 'content',
    name: 'search',
    body: {
      query:
        'query Search($text: String!, $kinds: [SearchKind!]) { search(text: $text, kinds: $kinds) { __typename ... on User { name } ... on Post { title } ... on Tag { name posts { id } } } }',
      variables: { text: 'g', kinds: ['POST', 'TAG', 'USER'] },
    },
  },
  {
    suite: 'content',
    name: 'filtered posts',
    body: {
      query:
        'query Filtered($f: PostFilter, $o: PostOrderInput) { posts(filter: $f, order: $o, first: 10) { id title likes } }',
      variables: {
        f: { status: ['PUBLISHED', 'DRAFT'], tags: ['graphql'], or: [{ text: 'proxy' }] },
        o: { field: 'LIKES', direction: 'ASC' },
      },
    },
  },
  {
    suite: 'content',
    name: 'node lookup',
    body: {
      query: '{ node(id: "c2") { id ... on Comment { text parent { id } post { title } } } }',
    },
  },
  {
    suite: 'mutations',
    name: 'create post',
    body: {
      query:
        'mutation Create($input: CreatePostInput!) { createPost(input: $input) { id status tags { name } } }',
      variables: {
        input: {
          title: 'New',
          body: 'Body',
          tags: ['demo'],
          status: 'PUBLISHED',
          seo: { title: 'SEO', keywords: ['a'] },
        },
      },
    },
  },
  {
    suite: 'mutations',
    name: 'like post',
    body: { query: 'mutation { likePost(postId: "p1") { id likes } }' },
  },
  {
    suite: 'mutations',
    name: 'comment',
    body: {
      query:
        'mutation Comment($in: AddCommentInput!) { addComment(input: $in) { id text post { id } } }',
      variables: { in: { postId: 'p1', text: 'hi' } },
    },
  },
  {
    suite: 'mutations',
    name: 'update role',
    body: { query: 'mutation { updateRole(userId: "u3", role: EDITOR) { id role } } ' },
  },
  // 13: subscription over SSE, see run.mjs
  {
    suite: 'subscriptions',
    name: 'post added subscription',
    sse: true,
    body: { query: 'subscription OnPost { postAdded(status: PUBLISHED) { id title } }' },
  },
  {
    suite: 'misc',
    name: 'batch: tags and users',
    body: [{ query: '{ tags { name } }' }, { query: '{ users(role: ADMIN) { id name } }' }],
  },
  { suite: 'misc', name: 'invalid query', body: { query: '{ viewer { unknownField } }' } },
  { suite: 'misc', name: 'introspection', body: { query: '{ __schema { queryType { name } } }' } },
  {
    suite: 'misc',
    name: 'conditional skip',
    body: {
      query:
        'query Cond($withStats: Boolean!) { viewer { id stats @include(if: $withStats) { totalLikes } } }',
      variables: { withStats: false },
    },
  },
  // 18: a test that sends no X-Test-Name (counted as "unknown")
  { anonymous: true, body: { query: '{ viewer { videos { id title } } }' } },
];
