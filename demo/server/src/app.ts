import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createPubSub, createSchema, createYoga, filter, pipe, type Plugin } from 'graphql-yoga';
import { GraphQLError, NoSchemaIntrospectionCustomRule } from 'graphql';

type Role = 'ADMIN' | 'EDITOR' | 'AUTHOR' | 'READER';
type PostStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  bio: string | null;
  following: string[];
}
interface PostRow {
  id: string;
  title: string;
  body: string;
  authorId: string;
  status: PostStatus;
  tags: string[];
  likes: number;
  publishedAt: string | null;
}
interface VideoRow {
  id: string;
  title: string;
  authorId: string;
  tags: string[];
  likes: number;
  durationSec: number;
  resolution: 'SD' | 'HD' | 'UHD';
  publishedAt: string;
}
interface CommentRow {
  id: string;
  text: string;
  authorId: string;
  postId: string;
  parentId: string | null;
  createdAt: string;
}

export const typeDefs = readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8');

function seed() {
  const users: UserRow[] = [
    {
      id: 'u1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'ADMIN',
      bio: 'Editor in chief',
      following: ['u2', 'u3'],
    },
    {
      id: 'u2',
      name: 'Bob',
      email: 'bob@example.com',
      role: 'AUTHOR',
      bio: null,
      following: ['u1'],
    },
    {
      id: 'u3',
      name: 'Carol',
      email: null,
      role: 'READER',
      bio: 'Reads everything',
      following: ['u1', 'u2'],
    },
  ];
  const posts: PostRow[] = [
    {
      id: 'p1',
      title: 'GraphQL coverage',
      body: '# Why coverage',
      authorId: 'u1',
      status: 'PUBLISHED',
      tags: ['graphql', 'testing'],
      likes: 12,
      publishedAt: '2026-01-10T10:00:00Z',
    },
    {
      id: 'p2',
      title: 'Proxies explained',
      body: 'Proxies sit in between',
      authorId: 'u2',
      status: 'PUBLISHED',
      tags: ['http'],
      likes: 5,
      publishedAt: '2026-02-01T09:00:00Z',
    },
    {
      id: 'p3',
      title: 'Draft ideas',
      body: 'tbd',
      authorId: 'u2',
      status: 'DRAFT',
      tags: [],
      likes: 0,
      publishedAt: null,
    },
  ];
  const videos: VideoRow[] = [
    {
      id: 'v1',
      title: 'Voyager tour',
      authorId: 'u1',
      tags: ['graphql'],
      likes: 30,
      durationSec: 420,
      resolution: 'HD',
      publishedAt: '2026-03-03T12:00:00Z',
    },
  ];
  const comments: CommentRow[] = [
    {
      id: 'c1',
      text: 'Great post',
      authorId: 'u3',
      postId: 'p1',
      parentId: null,
      createdAt: '2026-01-11T08:00:00Z',
    },
    {
      id: 'c2',
      text: 'Agreed',
      authorId: 'u2',
      postId: 'p1',
      parentId: 'c1',
      createdAt: '2026-01-11T09:00:00Z',
    },
    {
      id: 'c3',
      text: 'Nice',
      authorId: 'u1',
      postId: 'p2',
      parentId: null,
      createdAt: '2026-02-02T10:00:00Z',
    },
  ];
  return { users, posts, videos, comments, seq: 100 };
}

export interface DemoOptions {
  /** Reject introspection queries (to test the "introspection disabled" path). */
  disableIntrospection?: boolean;
}

export function createDemoYoga(options: DemoOptions = {}) {
  const db = seed();
  const pubsub = createPubSub<{ postAdded: [PostRow]; commentAdded: [string, CommentRow] }>();
  const userById = (id: string) => db.users.find((u) => u.id === id) ?? null;
  const postById = (id: string) => db.posts.find((p) => p.id === id) ?? null;
  const mustPost = (id: string) => {
    const p = postById(id);
    if (!p) throw new GraphQLError(`Post ${id} not found`, { extensions: { code: 'NOT_FOUND' } });
    return p;
  };
  const mustUser = (id: string) => {
    const u = userById(id);
    if (!u) throw new GraphQLError(`User ${id} not found`, { extensions: { code: 'NOT_FOUND' } });
    return u;
  };
  const tagRow = (name: string) => ({ name });
  const allTags = () =>
    [...new Set([...db.posts, ...db.videos].flatMap((c) => c.tags))].sort().map(tagRow);
  const nodeById = (id: string) =>
    userById(id) ??
    postById(id) ??
    db.videos.find((v) => v.id === id) ??
    db.comments.find((c) => c.id === id) ??
    null;
  const typeOf = (obj: object): string => {
    if ('role' in obj) return 'User';
    if ('durationSec' in obj) return 'Video';
    if ('body' in obj) return 'Post';
    if ('postId' in obj) return 'Comment';
    return 'Tag';
  };

  const schema = createSchema({
    typeDefs,
    resolvers: {
      Node: { __resolveType: typeOf },
      Content: { __resolveType: typeOf },
      SearchResult: { __resolveType: typeOf },
      Query: {
        viewer: () => db.users[0],
        user: (_: unknown, a: { id: string }) => userById(a.id),
        users: (_: unknown, a: { role?: Role; first: number }) =>
          db.users.filter((u) => !a.role || u.role === a.role).slice(0, a.first),
        node: (_: unknown, a: { id: string }) => nodeById(a.id),
        post: (_: unknown, a: { id: string }) => postById(a.id),
        posts: (
          _: unknown,
          a: {
            filter?: { status?: PostStatus[]; authorId?: string; tags?: string[]; text?: string };
            order?: { field: string; direction: 'ASC' | 'DESC' };
            first: number;
          },
        ) => {
          let list = db.posts.filter(
            (p) =>
              (!a.filter?.status || a.filter.status.includes(p.status)) &&
              (!a.filter?.authorId || p.authorId === a.filter.authorId) &&
              (!a.filter?.tags || a.filter.tags.some((t) => p.tags.includes(t))) &&
              (!a.filter?.text || p.title.toLowerCase().includes(a.filter.text.toLowerCase())),
          );
          if (a.order) {
            const key =
              a.order.field === 'LIKES'
                ? 'likes'
                : a.order.field === 'TITLE'
                  ? 'title'
                  : 'publishedAt';
            const dir = a.order.direction === 'ASC' ? 1 : -1;
            list = [...list].sort((x, y) => ((x[key] ?? '') > (y[key] ?? '') ? dir : -dir));
          }
          return list.slice(0, a.first);
        },
        feed: (_: unknown, a: { first: number }) =>
          [...db.posts.filter((p) => p.status === 'PUBLISHED'), ...db.videos]
            .sort((x, y) => String(y.publishedAt).localeCompare(String(x.publishedAt)))
            .slice(0, a.first),
        search: (_: unknown, a: { text: string; kinds?: string[] }) => {
          const q = a.text.toLowerCase();
          const want = (k: string) => !a.kinds || a.kinds.includes(k);
          return [
            ...(want('USER') ? db.users.filter((u) => u.name.toLowerCase().includes(q)) : []),
            ...(want('POST') ? db.posts.filter((p) => p.title.toLowerCase().includes(q)) : []),
            ...(want('VIDEO') ? db.videos.filter((v) => v.title.toLowerCase().includes(q)) : []),
            ...(want('TAG') ? allTags().filter((t) => t.name.includes(q)) : []),
          ];
        },
        tags: allTags,
      },
      Mutation: {
        createPost: (
          _: unknown,
          a: { input: { title: string; body: string; tags?: string[]; status: PostStatus } },
        ) => {
          const post: PostRow = {
            id: `p${++db.seq}`,
            title: a.input.title,
            body: a.input.body,
            authorId: 'u1',
            status: a.input.status,
            tags: a.input.tags ?? [],
            likes: 0,
            publishedAt: a.input.status === 'PUBLISHED' ? new Date().toISOString() : null,
          };
          db.posts.push(post);
          void pubsub.publish('postAdded', post);
          return post;
        },
        updatePost: (
          _: unknown,
          a: { id: string; input: Partial<Pick<PostRow, 'title' | 'body' | 'status' | 'tags'>> },
        ) => {
          const post = mustPost(a.id);
          for (const [k, v] of Object.entries(a.input))
            if (v != null) Object.assign(post, { [k]: v });
          return post;
        },
        deletePost: (_: unknown, a: { id: string }) => {
          const i = db.posts.findIndex((p) => p.id === a.id);
          if (i >= 0) db.posts.splice(i, 1);
          return i >= 0;
        },
        likePost: (_: unknown, a: { postId: string }) => {
          const post = mustPost(a.postId);
          post.likes += 1;
          return post;
        },
        addComment: (
          _: unknown,
          a: { input: { postId: string; text: string; parentId?: string } },
        ) => {
          mustPost(a.input.postId);
          const c: CommentRow = {
            id: `c${++db.seq}`,
            text: a.input.text,
            authorId: 'u1',
            postId: a.input.postId,
            parentId: a.input.parentId ?? null,
            createdAt: new Date().toISOString(),
          };
          db.comments.push(c);
          void pubsub.publish('commentAdded', c.postId, c);
          return c;
        },
        updateRole: (_: unknown, a: { userId: string; role: Role }) => {
          const u = mustUser(a.userId);
          u.role = a.role;
          return u;
        },
        follow: (_: unknown, a: { userId: string }) => {
          const target = mustUser(a.userId);
          if (!db.users[0]!.following.includes(target.id)) db.users[0]!.following.push(target.id);
          return target;
        },
      },
      Subscription: {
        postAdded: {
          subscribe: (_: unknown, a: { status?: PostStatus }) =>
            pipe(
              pubsub.subscribe('postAdded'),
              filter((p: PostRow) => !a.status || p.status === a.status),
            ),
          resolve: (p: PostRow) => p,
        },
        commentAdded: {
          subscribe: (_: unknown, a: { postId: string }) =>
            pubsub.subscribe('commentAdded', a.postId),
          resolve: (c: CommentRow) => c,
        },
      },
      User: {
        avatarUrl: (u: UserRow, a: { size: number }) =>
          `https://avatars.example.com/${u.id}?s=${a.size}`,
        posts: (u: UserRow, a: { first: number; status?: PostStatus }) =>
          db.posts
            .filter((p) => p.authorId === u.id && (!a.status || p.status === a.status))
            .slice(0, a.first),
        videos: (u: UserRow) => db.videos.filter((v) => v.authorId === u.id),
        followers: (u: UserRow, a: { first: number }) =>
          db.users.filter((x) => x.following.includes(u.id)).slice(0, a.first),
        following: (u: UserRow) => u.following.map((id) => userById(id)).filter(Boolean),
        stats: (u: UserRow) => {
          const own = db.posts.filter((p) => p.authorId === u.id);
          return {
            postCount: own.length,
            followerCount: db.users.filter((x) => x.following.includes(u.id)).length,
            totalLikes: own.reduce((s, p) => s + p.likes, 0),
          };
        },
      },
      Post: {
        author: (p: PostRow) => userById(p.authorId),
        tags: (p: PostRow) => p.tags.map(tagRow),
        body: (p: PostRow, a: { format: string }) =>
          a.format === 'HTML'
            ? `<p>${p.body}</p>`
            : a.format === 'PLAIN'
              ? p.body.replace(/[#*_]/g, '')
              : p.body,
        comments: (p: PostRow, a: { first: number; order: string }) => {
          let list = db.comments.filter((c) => c.postId === p.id && c.parentId === null);
          list = [...list].sort(
            (x, y) => (a.order === 'OLDEST' ? 1 : -1) * x.createdAt.localeCompare(y.createdAt),
          );
          const page = list.slice(0, a.first);
          return {
            totalCount: list.length,
            edges: page.map((node) => ({ cursor: Buffer.from(node.id).toString('base64'), node })),
            pageInfo: {
              hasNextPage: list.length > page.length,
              endCursor: page.length
                ? Buffer.from(page[page.length - 1]!.id).toString('base64')
                : null,
            },
          };
        },
      },
      Video: {
        author: (v: VideoRow) => userById(v.authorId),
        tags: (v: VideoRow) => v.tags.map(tagRow),
      },
      Comment: {
        author: (c: CommentRow) => userById(c.authorId),
        post: (c: CommentRow) => postById(c.postId),
        replies: (c: CommentRow) => db.comments.filter((x) => x.parentId === c.id),
        parent: (c: CommentRow) => db.comments.find((x) => x.id === c.parentId) ?? null,
      },
      Tag: {
        posts: (t: { name: string }) => db.posts.filter((p) => p.tags.includes(t.name)),
      },
    },
  });

  const plugins: Plugin[] = [];
  if (options.disableIntrospection) {
    plugins.push({
      onValidate({ addValidationRule }) {
        addValidationRule(NoSchemaIntrospectionCustomRule);
      },
    });
  }

  return createYoga({
    schema,
    plugins,
    graphqlEndpoint: '/graphql',
    landingPage: false,
    graphiql: false,
    batching: { limit: 20 },
    logging: false,
  });
}

/** Start the demo API on `port` (0 = random). Resolves with the http server. */
export function startDemoServer(port: number, options: DemoOptions = {}): Promise<Server> {
  const yoga = createDemoYoga(options);
  const server = createServer(yoga);
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}
