import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { SchemaRegistry } from './schema-registry.js';
import type { RunRow, Storage } from './storage/storage.js';

/** Run metadata extracted from request headers / path. */
export interface RunMeta {
  runId?: string | undefined;
  environment?: string | undefined;
  branch?: string | undefined;
  build?: string | undefined;
  commit?: string | undefined;
  team?: string | undefined;
  testSuite?: string | undefined;
}

export interface CreateRunInput extends Omit<RunMeta, 'runId'> {
  id?: string | undefined;
  target?: string | undefined;
  labels?: Record<string, string> | undefined;
}

const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const isValidRunId = (id: string) => RUN_ID.test(id);

/**
 * Resolves which run a request belongs to:
 *  1. explicit run id (X-Coverage-Run-Id header or /proxy/<runId>/graphql);
 *  2. the latest running run created via API/CLI for that target;
 *  3. an automatic run per metadata combination, closed after `idleTimeoutSec`.
 */
export class RunManager {
  private readonly cache = new Map<string, RunRow>();
  private readonly autoByKey = new Map<string, string>();
  private explicit = new Map<string, { run: RunRow | null; at: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly schemas: SchemaRegistry,
    private readonly log: Logger,
  ) {}

  private async insert(input: CreateRunInput & { auto: boolean; target: string }): Promise<RunRow> {
    const now = Date.now();
    const run = await this.storage.createRun({
      id: input.id ?? randomUUID(),
      target: input.target,
      schemaSnapshotId: this.schemas.get(input.target)?.snapshotId ?? null,
      auto: input.auto,
      environment: input.environment ?? null,
      branch: input.branch ?? null,
      commitSha: input.commit ?? null,
      buildId: input.build ?? null,
      team: input.team ?? null,
      testSuite: input.testSuite ?? null,
      labels: input.labels ?? {},
      startedAt: now,
      lastActivityAt: now,
    });
    this.cache.set(run.id, run);
    this.explicit.delete(run.target);
    this.log.info({ runId: run.id, target: run.target, auto: input.auto }, 'run started');
    return run;
  }

  /** Explicit lifecycle (POST /api/runs). */
  async create(input: CreateRunInput): Promise<RunRow> {
    const target = input.target ?? this.config.targets[0]!.name;
    this.schemas.targetConfig(target);
    if (input.id) {
      if (!isValidRunId(input.id)) throw new Error('run id must match [A-Za-z0-9._:-]{1,128}');
      const existing = await this.storage.getRun(input.id);
      if (existing) return existing;
    }
    return this.insert({ ...input, target, auto: false });
  }

  async finish(id: string): Promise<RunRow | null> {
    const run = await this.storage.finishRun(id, Date.now());
    this.cache.delete(id);
    if (run) this.explicit.delete(run.target);
    for (const [k, v] of this.autoByKey) if (v === id) this.autoByKey.delete(k);
    return run;
  }

  async resolve(target: string, meta: RunMeta): Promise<string> {
    if (meta.runId && isValidRunId(meta.runId)) {
      if (this.cache.has(meta.runId)) return meta.runId;
      const existing = await this.storage.getRun(meta.runId);
      if (existing) {
        this.cache.set(existing.id, existing);
        return existing.id;
      }
      return (await this.insert({ ...meta, id: meta.runId, target, auto: false })).id;
    }
    const explicit = await this.activeExplicit(target);
    if (explicit) return explicit.id;

    const key = JSON.stringify([
      target,
      meta.environment,
      meta.branch,
      meta.build,
      meta.commit,
      meta.team,
      meta.testSuite,
    ]);
    const autoId = this.autoByKey.get(key);
    if (autoId && this.cache.has(autoId)) return autoId;
    const run = await this.insert({ ...meta, target, auto: true, labels: { auto: 'true' } });
    this.autoByKey.set(key, run.id);
    return run.id;
  }

  /** Cached for 1s to keep the lookup off the hot path. */
  private async activeExplicit(target: string): Promise<RunRow | null> {
    const hit = this.explicit.get(target);
    if (hit && Date.now() - hit.at < 1000) return hit.run;
    const run = await this.storage.activeExplicitRun(target);
    this.explicit.set(target, { run, at: Date.now() });
    return run;
  }

  /** Finish automatic runs idle for longer than the configured timeout. */
  async closeIdle(now = Date.now()): Promise<string[]> {
    const idle = await this.storage.idleAutoRuns(now - this.config.runs.idleTimeoutSec * 1000);
    for (const r of idle) await this.finish(r.id);
    if (idle.length) this.log.info({ runs: idle.map((r) => r.id) }, 'idle auto runs finished');
    return idle.map((r) => r.id);
  }

  start(): void {
    const every = Math.min(60_000, this.config.runs.idleTimeoutSec * 250);
    this.timer = setInterval(() => {
      this.closeIdle().catch((e: Error) => this.log.warn({ err: e.message }, 'closeIdle failed'));
    }, every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
