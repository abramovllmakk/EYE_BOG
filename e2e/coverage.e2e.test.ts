import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, PROXY_URL } from './env.js';

const run = promisify(execFile);
const expected = JSON.parse(
  readFileSync(new URL('../demo/traffic/expected-coverage.json', import.meta.url), 'utf8'),
);
const RUN_ID = `e2e-${Date.now()}`;

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(ADMIN_URL + path, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

interface Ratio {
  covered: number;
  total: number;
}
interface Summary {
  summary: {
    requests: Record<string, number>;
    tests: number;
    fields: Ratio;
    types: Ratio & { fullyCovered: number };
    operations: { query: Ratio; mutation: Ratio; subscription: Ratio };
    arguments: Ratio;
    enumValues: Ratio;
    inputFields: Ratio;
    unionMembers: Ratio;
  };
  uncovered: { fields: string[]; types: string[] };
}

describe('end-to-end: demo tests → proxy → coverage', () => {
  let s: Summary;
  beforeAll(async () => {
    await api('/readyz');
    const { stdout } = await run(
      'node',
      [new URL('../demo/traffic/src/run.mjs', import.meta.url).pathname],
      {
        env: { ...process.env, PROXY_URL, RUN_ID },
      },
    );
    expect(stdout).toContain('sent 18 demo tests');
    // Wait for the analysis queue (flushes every few hundred ms).
    for (let i = 0; i < 40; i++) {
      s = await api<Summary>(`/api/runs/${RUN_ID}/summary`).catch(() => s);
      if (s?.summary.requests.total === expected.requests.total) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  it('counts requests and tests', () => {
    expect(s.summary.requests).toEqual(expected.requests);
    expect(s.summary.tests).toBe(expected.tests);
  });

  it('matches the hand-computed coverage numbers', () => {
    const pick = (r: Ratio) => ({ covered: r.covered, total: r.total });
    expect(pick(s.summary.fields)).toEqual(expected.fields);
    expect(pick(s.summary.operations.query)).toEqual(expected.operations.query);
    expect(pick(s.summary.operations.mutation)).toEqual(expected.operations.mutation);
    expect(pick(s.summary.operations.subscription)).toEqual(expected.operations.subscription);
    expect(pick(s.summary.arguments)).toEqual(expected.arguments);
    expect(pick(s.summary.enumValues)).toEqual(expected.enumValues);
    expect(pick(s.summary.inputFields)).toEqual(expected.inputFields);
    expect(pick(s.summary.unionMembers)).toEqual(expected.unionMembers);
    expect({ ...pick(s.summary.types), fullyCovered: s.summary.types.fullyCovered }).toEqual(
      expected.types,
    );
  });

  it('lists exactly the expected uncovered fields and types', () => {
    expect(s.uncovered.fields).toEqual(expected.uncoveredFields);
    expect(s.uncovered.types).toEqual(expected.uncoveredTypes);
  });

  it('shows interface-covered fields and per-field request counts', async () => {
    const cov = await api<{
      types: { fields: { coordinate: string; status: string; requests: number }[] }[];
    }>(`/api/runs/${RUN_ID}/coverage`);
    const fields = cov.types.flatMap((t) => t.fields);
    expect(
      fields
        .filter((f) => f.status === 'via_interface')
        .map((f) => f.coordinate)
        .sort(),
    ).toEqual(expected.viaInterface);
    for (const [c, n] of Object.entries(expected.fieldRequests)) {
      expect(fields.find((f) => f.coordinate === c)?.requests, c).toBe(n);
    }
  });

  it('counts how many requests used each type', async () => {
    const cov = await api<{ types: { name: string; requests: number }[] }>(
      `/api/runs/${RUN_ID}/coverage`,
    );
    for (const [t, n] of Object.entries(expected.typeRequests as Record<string, number>)) {
      expect(cov.types.find((x) => x.name === t)?.requests, t).toBe(n);
    }
  });

  it('keeps the proxy transparent for the demo API', async () => {
    const body = JSON.stringify({ query: '{ viewer { name } }' });
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(await res.json()).toEqual({ data: { viewer: { name: 'Alice' } } });
  });

  it('plans queries for exactly the uncovered fields and they run against the real API', async () => {
    const plan = await api<{
      projected: number;
      unreachable: string[];
      suggestions: { operationType: string; query: string; variables: object; gain: string[] }[];
    }>(`/api/runs/${RUN_ID}/gaps`);
    expect(plan.projected).toBe(100);
    expect(plan.unreachable).toEqual([]);
    expect([...new Set(plan.suggestions.flatMap((x) => x.gain))].sort()).toEqual(
      [...s.uncovered.fields].sort(),
    );
    // Read-only suggestions are executable as-is against the demo API (no validation errors).
    for (const sug of plan.suggestions.filter((x) => x.operationType === 'query')) {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-coverage-run-id': `${RUN_ID}-plan` },
        body: JSON.stringify({ query: sug.query, variables: sug.variables }),
      });
      const body = (await res.json()) as { errors?: { message: string }[] };
      expect(body.errors, sug.query).toBeUndefined();
    }
  });
});
