#!/usr/bin/env node
/**
 * Sends the demo test-suite through the proxy.
 *   PROXY_URL   proxy GraphQL endpoint (default http://localhost:4000/graphql)
 *   RUN_ID      optional X-Coverage-Run-Id (otherwise the proxy picks the active/auto run)
 *   BRANCH, ENVIRONMENT, BUILD, TEAM  optional run metadata headers
 *   ONLY        optional comma-separated test names to send (default: all)
 */
import { tests as allTests } from './tests.mjs';

const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;
const tests = only ? allTests.filter((t) => only.has(t.name)) : allTests;

const url = process.env.PROXY_URL ?? 'http://localhost:4000/graphql';
const meta = {
  ...(process.env.RUN_ID ? { 'x-coverage-run-id': process.env.RUN_ID } : {}),
  ...(process.env.BRANCH ? { 'x-coverage-branch': process.env.BRANCH } : {}),
  ...(process.env.ENVIRONMENT ? { 'x-coverage-env': process.env.ENVIRONMENT } : {}),
  ...(process.env.BUILD ? { 'x-coverage-build': process.env.BUILD } : {}),
  ...(process.env.TEAM ? { 'x-coverage-team': process.env.TEAM } : {}),
};

const headersFor = (t) => ({
  'content-type': 'application/json',
  ...meta,
  ...(t.anonymous ? {} : { 'x-test-name': t.name, 'x-test-suite': t.suite }),
});

async function send(t) {
  const res = await fetch(url, {
    method: 'POST',
    headers: headersFor(t),
    body: JSON.stringify(t.body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** Subscribe over SSE, trigger an event with a mutation, close after the first event. */
async function subscription(t) {
  const ctrl = new AbortController();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headersFor(t), accept: 'text/event-stream' },
    body: JSON.stringify(t.body),
    signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return buf;
      buf += dec.decode(value);
      if (buf.includes('"postAdded"')) return buf;
    }
  })();
  await new Promise((r) => setTimeout(r, 200));
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...meta,
      'x-test-name': 'subscription trigger',
      'x-test-suite': 'subscriptions',
    },
    body: JSON.stringify({
      query:
        'mutation Trigger { createPost(input: { title: "live", body: "b", status: PUBLISHED }) { id } }',
    }),
  });
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('no subscription event within 5s')), 5000),
  );
  const text = await Promise.race([got, timeout]);
  ctrl.abort();
  return { status: res.status, text };
}

let failed = 0;
for (const t of tests) {
  const label = t.anonymous ? '(no test name)' : `${t.suite} / ${t.name}`;
  try {
    const r = t.sse ? await subscription(t) : await send(t);
    console.log(`${r.status}  ${label}`);
  } catch (e) {
    failed++;
    console.error(`ERR  ${label}: ${e.message}`);
  }
}
// Give the proxy a moment to close the SSE request and enqueue it.
await new Promise((r) => setTimeout(r, 300));
console.log(
  failed ? `${failed} demo tests failed to send` : `sent ${tests.length} demo tests through ${url}`,
);
process.exit(failed ? 1 : 0);
