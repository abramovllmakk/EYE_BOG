import { LRUCache } from 'lru-cache';
import {
  computeCoverage,
  emptyCoverageData,
  mergeCoverageData,
  type CoverageData,
  type CoverageReport,
  type SchemaModel,
} from '@gqlcov/core';
import type { Config } from './config.js';
import type { AnalysisPipeline } from './pipeline.js';
import type { LoadedSchema, SchemaRegistry } from './schema-registry.js';
import type { RunRow, Storage } from './storage/storage.js';

export interface RunCoverage {
  run: RunRow;
  schema: LoadedSchema;
  data: CoverageData;
  report: CoverageReport;
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** Loads run coverage from storage and computes reports (cached per run data version). */
export class CoverageService {
  private readonly cache = new LRUCache<string, RunCoverage>({ max: 200 });

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly schemas: SchemaRegistry,
    private readonly pipeline: AnalysisPipeline,
  ) {}

  /** Schema version a run was recorded against (falls back to the target's current schema). */
  async schemaFor(run: RunRow): Promise<LoadedSchema | null> {
    if (run.schemaSnapshotId != null) {
      const s = await this.schemas.byIdOrNull(run.schemaSnapshotId);
      if (s) return s;
    }
    const current = await this.schemas.ensure(run.target);
    if (current) await this.storage.setRunSnapshot(run.id, current.snapshotId);
    return current ?? null;
  }

  async getRun(id: string): Promise<RunRow> {
    const run = await this.storage.getRun(id);
    if (!run) throw new NotFoundError(`Run ${id} not found`);
    return run;
  }

  /** @param testSuite restrict to tests of one suite (grouping by test suite). */
  async coverage(
    runId: string,
    opts: { testSuite?: string | undefined } = {},
  ): Promise<RunCoverage> {
    const run = await this.getRun(runId);
    const version = this.pipeline.versions.get(runId) ?? 0;
    const key = `${runId}:${version}:${run.requests.total}:${opts.testSuite ?? ''}`;
    const hit = this.cache.get(key);
    if (hit) return { ...hit, run };
    const schema = await this.schemaFor(run);
    if (!schema) throw new NotFoundError(`No schema available for target ${run.target}`);
    let testKeys: string[] | undefined;
    if (opts.testSuite) {
      testKeys = (await this.storage.listTests(runId))
        .filter((t) => t.suite === opts.testSuite)
        .map((t) => t.testKey);
    }
    const data = await this.storage.loadCoverage(runId, testKeys ? { testKeys } : {});
    const report = computeCoverage(schema.model, data, {
      propagateInterfaceCoverage: this.config.coverage.propagateInterfaceCoverage,
    });
    const result = { run, schema, data, report };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Union coverage of several runs of the same target (e.g. all runs of a team): a field covered
   * by any run counts. Evaluated against the schema of the most recent run.
   */
  async aggregate(
    runs: RunRow[],
  ): Promise<{ schema: LoadedSchema; data: CoverageData; report: CoverageReport } | null> {
    const newest = [...runs].sort((a, b) => b.startedAt - a.startedAt);
    const schema = newest.length ? await this.schemaFor(newest[0]!) : null;
    if (!schema) return null;
    const data = emptyCoverageData();
    for (const run of newest) mergeCoverageData(data, await this.storage.loadCoverage(run.id));
    const report = computeCoverage(schema.model, data, {
      propagateInterfaceCoverage: this.config.coverage.propagateInterfaceCoverage,
    });
    return { schema, data, report };
  }

  model(rc: RunCoverage): SchemaModel {
    return rc.schema.model;
  }
}
