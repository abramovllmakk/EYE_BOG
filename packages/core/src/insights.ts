/**
 * Risk signals of a run: places where coverage numbers alone hide a problem.
 *
 *  - deprecatedInUse: tests still select fields marked @deprecated; when the field is removed the
 *    tests break, so they should migrate first.
 *  - untestedMutations: root Mutation fields no test calls; writes are the riskiest untested code.
 *  - untestedSubscriptions: root Subscription fields no test subscribes to.
 *  - conditionalOnly: fields counted only under @include/@skip whose condition was unknown.
 *  - untouchedTypes: object/interface types no request reached at all.
 *  - unusedArguments: arguments of covered fields that no test ever passed (pagination, filters…).
 */
import type { CoverageReport } from './coverage.js';
import type { SchemaModel } from './schema-model.js';

export interface Insights {
  deprecatedInUse: { coordinate: string; requests: number }[];
  untestedMutations: string[];
  untestedSubscriptions: string[];
  conditionalOnly: string[];
  untouchedTypes: string[];
  unusedArguments: string[];
}

export function insights(model: SchemaModel, report: CoverageReport): Insights {
  const deprecated = new Set<string>();
  for (const t of model.types)
    for (const f of t.fields) if (f.deprecated) deprecated.add(f.coordinate);
  const out: Insights = {
    deprecatedInUse: [],
    untestedMutations: [],
    untestedSubscriptions: [],
    conditionalOnly: [],
    untouchedTypes: [],
    unusedArguments: [],
  };
  for (const t of report.types) {
    if (t.kind !== 'OBJECT' && t.kind !== 'INTERFACE') continue;
    if (
      t.status === 'uncovered' &&
      t.name !== model.roots.mutation &&
      t.name !== model.roots.subscription
    )
      out.untouchedTypes.push(t.name);
    for (const f of t.fields) {
      const covered = f.status === 'covered';
      if (covered && deprecated.has(f.coordinate))
        out.deprecatedInUse.push({ coordinate: f.coordinate, requests: f.requests });
      if (!covered && t.name === model.roots.mutation) out.untestedMutations.push(f.coordinate);
      if (!covered && t.name === model.roots.subscription)
        out.untestedSubscriptions.push(f.coordinate);
      if (covered && f.conditionalOnly) out.conditionalOnly.push(f.coordinate);
      if (covered) for (const a of f.args) if (!a.used) out.unusedArguments.push(a.coordinate);
    }
  }
  out.deprecatedInUse.sort(
    (a, b) => b.requests - a.requests || a.coordinate.localeCompare(b.coordinate),
  );
  for (const k of [
    'untestedMutations',
    'untestedSubscriptions',
    'conditionalOnly',
    'untouchedTypes',
    'unusedArguments',
  ] as const)
    out[k].sort();
  return out;
}
