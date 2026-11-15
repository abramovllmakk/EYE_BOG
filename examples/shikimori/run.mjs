#!/usr/bin/env node
/**
 * Runs the Shikimori "autotests" through the gqlcov proxy.
 *   PROXY_URL  default http://localhost:4000/t/shikimori/graphql
 *   RUN_ID     optional run id (X-Coverage-Run-Id)
 * Requests are spaced out to respect Shikimori's public rate limits (5 rps / 90 rpm).
 */
import { tests } from './tests.mjs';

const url = process.env.PROXY_URL ?? 'http://localhost:4000/t/shikimori/graphql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

for (const t of tests) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'gqlcov-demo',
      ...(process.env.RUN_ID ? { 'x-coverage-run-id': process.env.RUN_ID } : {}),
      // fetch() cannot send Cyrillic header values as-is: percent-encode them (gqlcov decodes).
      'x-test-name': encodeURIComponent(t.name),
      'x-test-suite': encodeURIComponent(t.suite),
    },
    body: JSON.stringify(t.body),
  });
  const json = await res.json().catch(() => ({}));
  const ok = t.expectErrors ? Array.isArray(json.errors) : !json.errors && t.check(json.data ?? {});
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${res.status}  ${t.suite} / ${t.name}${!ok && json.errors ? `  ← ${json.errors[0].message}` : ''}`,
  );
  await sleep(400);
}
console.log(failed ? `${failed} tests failed` : `all ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
