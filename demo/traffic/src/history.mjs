#!/usr/bin/env node
/**
 * Seeds a realistic two-week history so the dashboards have something to show: daily main builds
 * of two teams with growing coverage, feature branches, and one regression on a branch.
 *   ADMIN_URL  admin API (default http://localhost:4001)
 *   PROXY_URL  proxy GraphQL endpoint (default http://localhost:4000/graphql)
 * Idempotent: runs that already exist are skipped.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const admin = process.env.ADMIN_URL ?? 'http://localhost:4001';
const proxy = process.env.PROXY_URL ?? 'http://localhost:4000/graphql';
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const DAY = 86_400_000;

const base = ['feed', 'post with comments', 'viewer profile'];
const week1 = [...base, 'search', 'user by id with posts', 'filtered posts'];
const week2 = [...week1, 'create post', 'followers', 'node lookup'];
const week3 = [...week2, 'comment', 'like post', 'update role', 'batch: tags and users'];
const plan = [
  // Nightly main pipeline: the whole suite, growing as teams merge tests.
  { days: 13, build: 101, branch: 'main', team: 'qa', tests: base },
  { days: 11, build: 104, branch: 'main', team: 'qa', tests: week1 },
  { days: 9, build: 107, branch: 'main', team: 'qa', tests: [...week1, 'create post'] },
  { days: 7, build: 110, branch: 'main', team: 'qa', tests: week2 },
  { days: 5, build: 113, branch: 'main', team: 'qa', tests: [...week2, 'comment', 'like post'] },
  { days: 3, build: 116, branch: 'main', team: 'qa', tests: week3 },
  { days: 1, build: 119, branch: 'main', team: 'qa', tests: null },
  // Team feature branches.
  {
    days: 8,
    build: 108,
    branch: 'feature/comments',
    env: 'dev',
    team: 'content',
    tests: ['feed', 'post with comments', 'comment', 'like post', 'node lookup'],
  },
  {
    days: 6,
    build: 111,
    branch: 'feature/profile-stats',
    env: 'dev',
    team: 'profile',
    tests: [
      'viewer profile',
      'user by id with posts',
      'followers',
      'update role',
      'conditional skip',
    ],
  },
  // A refactoring branch that accidentally dropped the search and filtering tests.
  {
    days: 2,
    build: 117,
    branch: 'feature/video-player',
    env: 'dev',
    team: 'content',
    tests: week3.filter((t) => t !== 'search' && t !== 'filtered posts'),
  },
];

const api = async (method, path, body) => {
  const res = await fetch(admin + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    json: res.status === 204 ? null : await res.json().catch(() => null),
  };
};

for (const r of plan) {
  const id = `demo-${r.branch.replace(/[^A-Za-z0-9]+/g, '-')}-${r.build}`;
  if ((await api('GET', `/api/runs/${id}`)).status === 200) {
    console.log(`skip   ${id} (exists)`);
    continue;
  }
  const started = Date.now() - r.days * DAY;
  const created = await api('POST', '/api/runs', {
    id,
    branch: r.branch,
    build: String(r.build),
    environment: r.env ?? 'stage',
    team: r.team,
    commit: (r.build * 2654435761).toString(16).slice(0, 8),
    startedAt: started,
  });
  if (created.status >= 300)
    throw new Error(`cannot create ${id}: ${JSON.stringify(created.json)}`);
  const sent = spawnSync(process.execPath, [runner], {
    env: {
      ...process.env,
      PROXY_URL: proxy,
      RUN_ID: id,
      ...(r.tests ? { ONLY: r.tests.join(',') } : {}),
    },
    encoding: 'utf8',
  });
  if (sent.status !== 0) throw new Error(`traffic for ${id} failed:\n${sent.stderr}`);
  await new Promise((res) => setTimeout(res, 400));
  await api('POST', `/api/runs/${id}/finish`);
  const s = await api('GET', `/api/runs/${id}`);
  console.log(`seeded ${id}: ${s.json?.summary?.fields ?? '?'}% fields`);
}
console.log('history ready: open the Timeline, Compare and Teams screens');
