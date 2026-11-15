#!/usr/bin/env node
/**
 * Proxy overhead benchmark (autocannon).
 *   DIRECT_URL  backend endpoint      (default http://localhost:4100/graphql)
 *   PROXY_URL   proxy endpoint        (default http://localhost:4000/graphql)
 *   ADMIN_URL   gqlcov admin/metrics  (default http://localhost:4001)
 *   DURATION (s, default 10), CONNECTIONS (default 20), RATE (total req/s, default 0 = saturate)
 * Reports latency percentiles for both and the proxy's own overhead histogram (excludes backend time).
 */
import autocannon from 'autocannon';

const DIRECT = process.env.DIRECT_URL ?? 'http://localhost:4100/graphql';
const PROXY = process.env.PROXY_URL ?? 'http://localhost:4000/graphql';
const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:4001';
const duration = Number(process.env.DURATION ?? 10);
const connections = Number(process.env.CONNECTIONS ?? 20);
const rate = Number(process.env.RATE ?? 0);
const body = JSON.stringify({
  query:
    'query Bench($id: ID!) { user(id: $id) { id name posts(first: 3) { id title comments { totalCount } } } }',
  variables: { id: 'u1' },
});

const bench = (url, headers = {}) =>
  autocannon({
    url,
    method: 'POST',
    duration,
    connections,
    body,
    ...(rate ? { overallRate: rate } : {}),
    headers: { 'content-type': 'application/json', ...headers },
  });

async function overheadHistogram() {
  const text = await (await fetch(`${ADMIN}/metrics`)).text();
  const buckets = [];
  let count = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^gqlcov_proxy_overhead_seconds_bucket\{.*le="([^"]+)".*\} (\d+)/);
    if (m) buckets.push([m[1] === '+Inf' ? Infinity : Number(m[1]), Number(m[2])]);
    const c = line.match(/^gqlcov_proxy_overhead_seconds_count\{.*\} (\d+)/);
    if (c) count = Number(c[1]);
  }
  const q = (p) => buckets.find(([, n]) => n >= p * count)?.[0];
  return { count, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

const fmt = (r) =>
  `p50 ${r.latency.p50} ms, p97.5 ${r.latency.p97_5} ms, p99 ${r.latency.p99} ms, avg ${r.latency.average.toFixed(2)} ms, ${Math.round(r.requests.average)} req/s, errors ${r.errors + r.non2xx}`;

console.log(
  `warming up… (${rate ? `${rate} req/s` : 'saturating'}, ${connections} connections, ${duration}s)`,
);
await bench(PROXY).then(() => {});
const before = await overheadHistogram();
console.log(`direct  ${DIRECT}`);
const direct = await bench(DIRECT);
console.log(`  ${fmt(direct)}`);
console.log(`proxy   ${PROXY}`);
const proxied = await bench(PROXY, {
  'x-coverage-run-id': `bench-${Date.now()}`,
  'x-test-name': 'bench',
});
console.log(`  ${fmt(proxied)}`);
const after = await overheadHistogram();
const delta = (k) => (after[k] === undefined ? 'n/a' : `≤ ${after[k] * 1000} ms`);
console.log(
  `\nend-to-end latency added by the proxy (avg): ${(proxied.latency.average - direct.latency.average).toFixed(2)} ms`,
);
console.log(
  `proxy-only overhead histogram (${after.count - before.count} requests, bucket upper bounds): p50 ${delta('p50')}, p95 ${delta('p95')}, p99 ${delta('p99')}`,
);
