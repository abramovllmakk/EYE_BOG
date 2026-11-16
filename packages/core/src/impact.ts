/**
 * Test impact: what every test contributes to field coverage.
 *
 *  - `fields`: schema fields the test selected (only fields counted by the report).
 *  - `unique`: fields no other test selects. Removing the test loses exactly these.
 *  - A test with fields but no unique ones is `redundant`: other tests cover all of it.
 *  - A test without counted fields (invalid queries, introspection only) is `empty`.
 *  - The minimal set is a greedy set cover: the smallest found subset of tests that keeps the same
 *    field coverage, in the order in which tests add the most new fields.
 */
import { parseTestKey, UNKNOWN_TEST, type CoverageData, type CoverageReport } from './coverage.js';

export interface TestImpact {
  testKey: string;
  suite: string | null;
  name: string;
  requests: number;
  fields: number;
  unique: string[];
  /** Fields other tests also cover. */
  shared: number;
  redundant: boolean;
  empty: boolean;
  /** Position in the minimal set (1-based), or null when the test is not needed for coverage. */
  minimalRank: number | null;
  /** Requests without the X-Test-Name header are grouped under `unknown`. */
  unnamed: boolean;
}

export interface ImpactReport {
  tests: TestImpact[];
  /** Field coverage of all tests together (counted fields). */
  coveredFields: number;
  totalFields: number;
  minimalSet: {
    testKeys: string[];
    /** Covered fields after each test of the minimal set, cumulative. */
    cumulative: number[];
  };
  redundant: number;
  empty: number;
}

export function testImpact(data: CoverageData, report: CoverageReport): ImpactReport {
  const counted = new Set<string>();
  for (const t of report.types) for (const f of t.fields) if (f.counted) counted.add(f.coordinate);

  const fieldsOf = new Map<string, Set<string>>();
  for (const key of Object.keys(data.tests)) fieldsOf.set(key, new Set());
  const owners = new Map<string, string[]>();
  for (const [coord, hit] of Object.entries(data.fields)) {
    if (!counted.has(coord)) continue;
    const tests = Object.keys(hit.tests);
    owners.set(coord, tests);
    for (const t of tests) {
      let s = fieldsOf.get(t);
      if (!s) fieldsOf.set(t, (s = new Set()));
      s.add(coord);
    }
  }

  // Greedy set cover; ties broken by test key for a stable order.
  const remaining = new Set(owners.keys());
  const pool = [...fieldsOf.keys()].sort();
  const minimal: string[] = [];
  const cumulative: number[] = [];
  let covered = 0;
  while (remaining.size) {
    let best = '';
    let gain = 0;
    for (const t of pool) {
      let g = 0;
      for (const f of fieldsOf.get(t)!) if (remaining.has(f)) g++;
      if (g > gain) [best, gain] = [t, g];
    }
    for (const f of fieldsOf.get(best)!) remaining.delete(f);
    pool.splice(pool.indexOf(best), 1);
    minimal.push(best);
    covered += gain;
    cumulative.push(covered);
  }
  const rank = new Map(minimal.map((t, i) => [t, i + 1]));

  const tests: TestImpact[] = [...fieldsOf.entries()].map(([key, fields]) => {
    const unique = [...fields].filter((f) => owners.get(f)!.length === 1).sort();
    const { suite, name } = parseTestKey(key);
    return {
      testKey: key,
      suite,
      name,
      requests: data.tests[key]?.requests ?? 0,
      fields: fields.size,
      unique,
      shared: fields.size - unique.length,
      redundant: fields.size > 0 && unique.length === 0,
      empty: fields.size === 0,
      minimalRank: rank.get(key) ?? null,
      unnamed: key === UNKNOWN_TEST,
    };
  });
  tests.sort(
    (a, b) =>
      b.unique.length - a.unique.length ||
      b.fields - a.fields ||
      a.testKey.localeCompare(b.testKey),
  );

  return {
    tests,
    coveredFields: owners.size,
    totalFields: report.summary.fields.total,
    minimalSet: { testKeys: minimal, cumulative },
    redundant: tests.filter((t) => t.redundant).length,
    empty: tests.filter((t) => t.empty).length,
  };
}
