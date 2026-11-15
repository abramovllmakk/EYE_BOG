import { performance } from 'node:perf_hooks';
import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';
import {
  CoverageAccumulator,
  analyzePrepared,
  maskHeaders,
  parseHttpGraphQLRequest,
  parseOperationsJson,
  persistedQueryHash,
  prepareDocument,
  redactVariables,
  type AnalysisResult,
  type GraphQLRequest,
  type PreparedDocument,
  type TestRef,
} from '@gqlcov/core';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import type { RunManager, RunMeta } from './runs.js';
import { sha256, type SchemaRegistry } from './schema-registry.js';
import type { NewOperationLog, QueryDocumentRow, Storage, WriteBatch } from './storage/storage.js';

export type Transport = 'post' | 'get' | 'batch' | 'multipart' | 'ws' | 'sse';

/** Everything the hot path hands over; all parsing happens in the worker. */
export interface ProxyJob {
  target: string;
  ts: number;
  transport: Transport;
  method: string;
  contentType?: string | undefined;
  body?: Buffer | undefined;
  query?: Record<string, string | undefined> | undefined;
  /** multipart `operations` field. */
  operationsJson?: string | undefined;
  /** Already parsed requests (WebSocket). */
  requests?: GraphQLRequest[] | undefined;
  headers: Record<string, string | string[] | undefined>;
  meta: RunMeta;
  test: TestRef;
  httpStatus: number | null;
  /** Buffered JSON response (for the has_errors flag), if small enough. */
  responseBody?: Buffer | undefined;
  /** Pre-computed has_errors per batch index (WebSocket). */
  responseErrors?: (boolean | null)[] | undefined;
  latencyMs: number | null;
}

interface PendingApq {
  hash: string;
  runId: string;
  target: string;
  request: GraphQLRequest;
  test: TestRef;
  log: NewOperationLog & { id?: number };
  at: number;
}

export interface PipelineHooks {
  /** Test hook: throw inside analysis (fail-open tests). */
  beforeAnalyze?: (req: GraphQLRequest) => void;
}

const APQ_PENDING_MAX = 1000;
const SLICE_MS = 2;
const WRITE_SLICE = 100;
const APQ_PENDING_TTL_MS = 10 * 60_000;

export class AnalysisPipeline {
  private queue: ProxyJob[] = [];
  private running = false;
  private scheduled = false;
  private readonly docCache: LRUCache<string, PreparedDocument>;
  private readonly knownDocs = new LRUCache<string, string>({ max: 20_000 });
  private readonly accumulators = new Map<
    string,
    { acc: CoverageAccumulator; lastActivityAt: number }
  >();
  private logs: (NewOperationLog & { id?: number })[] = [];
  private documents: QueryDocumentRow[] = [];
  private logUpdates: { id: number; patch: Partial<NewOperationLog> }[] = [];
  private pending: PendingApq[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];
  /** Bumped per run whenever new coverage was written (API cache invalidation). */
  readonly versions = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly schemas: SchemaRegistry,
    private readonly runs: RunManager,
    private readonly metrics: Metrics,
    private readonly log: Logger,
    readonly hooks: PipelineHooks = {},
  ) {
    this.docCache = new LRUCache({ max: config.cache.documents });
  }

  get length(): number {
    return this.queue.length;
  }

  /** Hot path: O(1), never throws. Returns false when the job was dropped. */
  enqueue(job: ProxyJob): boolean {
    if (this.queue.length >= this.config.queue.maxSize) {
      this.metrics.dropped.inc();
      return false;
    }
    this.queue.push(job);
    this.metrics.queueLength.set(this.queue.length);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => void this.drain());
    }
    return true;
  }

  start(): void {
    this.flushTimer = setInterval(() => void this.flush(), this.config.queue.flushIntervalMs);
    this.flushTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.drain();
    await this.flush();
  }

  /** Resolves when the queue is empty and everything is written (tests, run finish). */
  async idle(): Promise<void> {
    if (this.queue.length > 0 || this.running) {
      await new Promise<void>((r) => this.idleWaiters.push(r));
    }
    await this.flush();
  }

  private async drain(): Promise<void> {
    this.scheduled = false;
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.config.queue.batchSize);
        this.metrics.queueLength.set(this.queue.length);
        let sliceStart = performance.now();
        for (const job of batch) {
          // Time-slice: never hold the event loop for more than ~4 ms at a time.
          if (performance.now() - sliceStart > SLICE_MS) {
            await new Promise((r) => setImmediate(r));
            sliceStart = performance.now();
          }
          try {
            await this.process(job);
          } catch (e) {
            this.metrics.errors.inc({ component: 'analyzer' });
            this.log.error(
              { err: (e as Error).message, target: job.target },
              'analysis failed (request was proxied normally)',
            );
          }
        }
        if (this.logs.length >= 2000) await this.flush();
        // Yield to the event loop between batches so proxying is never starved.
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private accumulator(runId: string): CoverageAccumulator {
    let a = this.accumulators.get(runId);
    if (!a)
      this.accumulators.set(
        runId,
        (a = { acc: new CoverageAccumulator(), lastActivityAt: Date.now() }),
      );
    a.lastActivityAt = Date.now();
    return a.acc;
  }

  private parseRequests(job: ProxyJob): GraphQLRequest[] | { error: string } {
    if (job.requests) return job.requests;
    const outcome =
      job.operationsJson !== undefined
        ? parseOperationsJson(job.operationsJson)
        : parseHttpGraphQLRequest({
            method: job.method,
            contentType: job.contentType,
            body: job.body?.toString('utf8'),
            query: job.query,
          });
    return 'error' in outcome ? outcome : outcome.requests;
  }

  private responseErrors(job: ProxyJob): (boolean | null)[] {
    if (job.responseErrors) return job.responseErrors;
    if (!job.responseBody) return [];
    try {
      const parsed: unknown = JSON.parse(job.responseBody.toString('utf8'));
      const flag = (x: unknown) =>
        typeof x === 'object' && x !== null
          ? Array.isArray((x as { errors?: unknown }).errors)
          : null;
      return Array.isArray(parsed) ? parsed.map(flag) : [flag(parsed)];
    } catch {
      return [];
    }
  }

  private baseLog(
    job: ProxyJob,
    runId: string,
    index: number | null,
    hasErrors: boolean | null,
  ): NewOperationLog {
    return {
      runId,
      target: job.target,
      ts: job.ts,
      operationName: null,
      operationType: null,
      queryHash: null,
      variables: null,
      headers: this.config.logging.storeHeaders
        ? maskHeaders(job.headers, this.config.logging.maskHeaders)
        : null,
      testName: job.test.name ?? null,
      testSuite: job.test.suite ?? null,
      httpStatus: job.httpStatus,
      hasErrors,
      status: 'invalid',
      errors: [],
      latencyMs: job.latencyMs,
      batchIndex: index,
      transport: job.transport,
      fields: [],
    };
  }

  private rememberDocument(hash: string, query: string, normalized: string | null): void {
    if (this.knownDocs.has(hash)) return;
    this.knownDocs.set(hash, query);
    this.documents.push({ hash, query, normalized });
  }

  private async lookupDocument(hash: string): Promise<string | null> {
    const mem = this.knownDocs.get(hash);
    if (mem) return mem;
    const row = await this.storage.getQueryDocument(hash);
    if (row) this.knownDocs.set(hash, row.query);
    return row?.query ?? null;
  }

  private async process(job: ProxyJob): Promise<void> {
    const runId = await this.runs.resolve(job.target, job.meta);
    const parsed = this.parseRequests(job);
    const errs = this.responseErrors(job);
    if ('error' in parsed) {
      const entry = this.baseLog(job, runId, null, errs[0] ?? null);
      entry.errors = [parsed.error];
      this.logs.push(entry);
      this.accumulator(runId).add({ status: 'invalid' } as AnalysisResult);
      this.metrics.analyzed.inc({ status: 'invalid' });
      return;
    }
    const batched = parsed.length > 1 || job.transport === 'batch';
    for (const [i, req] of parsed.entries()) {
      const entry = this.baseLog(job, runId, batched ? i : null, errs[i] ?? null);
      entry.operationName = req.operationName ?? null;
      entry.variables = redactVariables(req.variables, this.config.logging.variables);
      await this.analyzeOne(job.target, runId, req, job.test, entry);
    }
  }

  private async analyzeOne(
    target: string,
    runId: string,
    req: GraphQLRequest,
    test: TestRef,
    entry: NewOperationLog & { id?: number },
  ): Promise<void> {
    const apqHash = persistedQueryHash(req);
    let query = req.query ?? null;
    if (!query && apqHash) {
      query = await this.lookupDocument(apqHash);
      if (!query) {
        entry.status = 'unresolved';
        entry.queryHash = apqHash;
        entry.errors = [
          'Persisted query hash not seen yet (APQ); waiting for hash → query mapping',
        ];
        this.logs.push(entry);
        this.accumulator(runId).addUnresolved();
        this.metrics.analyzed.inc({ status: 'unresolved' });
        // Only executed requests can be resolved later; a PersistedQueryNotFound retry is not coverage.
        if (entry.hasErrors !== true && this.pending.length < APQ_PENDING_MAX) {
          this.pending.push({
            hash: apqHash,
            runId,
            target,
            request: req,
            test,
            log: entry,
            at: Date.now(),
          });
        }
        return;
      }
    }

    const loaded = await this.schemas.ensure(target);
    const queryHash = query ? sha256(query) : null;
    entry.queryHash = queryHash;

    if (!loaded || !query) {
      entry.status = loaded ? 'invalid' : 'no_schema';
      entry.errors = loaded ? ['Must provide query string.'] : ['No schema available for target'];
      if (query && queryHash) this.rememberDocument(queryHash, query, null);
      this.logs.push(entry);
      if (loaded) this.accumulator(runId).add({ status: 'invalid' } as AnalysisResult);
      this.metrics.analyzed.inc({ status: entry.status });
      return;
    }

    const cacheKey = `${loaded.hash}:${queryHash}`;
    let prepared = this.docCache.get(cacheKey);
    if (prepared) this.metrics.cacheHits.inc();
    else {
      prepared = prepareDocument(loaded.schema, query);
      this.docCache.set(cacheKey, prepared);
    }
    this.rememberDocument(queryHash!, query, prepared.normalizedQuery);
    if (apqHash && apqHash !== queryHash)
      this.rememberDocument(apqHash, query, prepared.normalizedQuery);

    this.hooks.beforeAnalyze?.(req);
    const result = analyzePrepared(loaded.schema, prepared, {
      operationName: req.operationName,
      variables: req.variables,
    });
    this.applyResult(runId, test, entry, result);
    this.logs.push(entry);

    if (this.pending.length) await this.resolvePending([queryHash!, ...(apqHash ? [apqHash] : [])]);
  }

  private applyResult(
    runId: string,
    test: TestRef,
    entry: NewOperationLog,
    result: AnalysisResult,
  ): void {
    entry.status = result.status;
    entry.errors = result.errors;
    entry.operationName = result.operationName ?? entry.operationName;
    entry.operationType = result.operationType;
    entry.fields = result.fields.map((f) => f.coordinate);
    this.accumulator(runId).add(result, test);
    this.metrics.analyzed.inc({ status: result.status });
  }

  /** Re-analyse executed APQ requests whose query text just became known. */
  private async resolvePending(hashes: string[]): Promise<void> {
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < APQ_PENDING_TTL_MS);
    const ready = this.pending.filter((p) => hashes.includes(p.hash));
    if (!ready.length) return;
    this.pending = this.pending.filter((p) => !hashes.includes(p.hash));
    for (const p of ready) {
      const query = this.knownDocs.get(p.hash)!;
      const loaded = this.schemas.get(p.target);
      if (!loaded) continue;
      const result = analyzePrepared(loaded.schema, prepareDocument(loaded.schema, query), {
        operationName: p.request.operationName,
        variables: p.request.variables,
      });
      const acc = this.accumulator(p.runId);
      acc.add(result, p.test);
      acc.correctUnresolved();
      const patch: Partial<NewOperationLog> = {
        status: result.status,
        errors: result.errors,
        operationName: result.operationName,
        operationType: result.operationType,
        fields: result.fields.map((f) => f.coordinate),
      };
      if (p.log.id !== undefined) this.logUpdates.push({ id: p.log.id, patch });
      else Object.assign(p.log, patch);
    }
  }

  /** Write buffered logs and coverage increments in one transaction. Fail-open on storage errors. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flushNow());
    return this.flushNow();
  }

  /**
   * SQLite writes are synchronous: split large batches into small transactions and yield between
   * them so a flush never stalls in-flight proxy requests. Coverage goes with the last slice.
   */
  private async writeInSlices(batch: WriteBatch): Promise<number[]> {
    const ids: number[] = [];
    const logs = batch.logs;
    for (let i = 0; i < logs.length || i === 0; i += WRITE_SLICE) {
      const last = i + WRITE_SLICE >= logs.length;
      const { logIds } = await this.storage.write({
        documents: i === 0 ? batch.documents : [],
        logs: logs.slice(i, i + WRITE_SLICE),
        logUpdates: i === 0 ? batch.logUpdates : [],
        coverage: last ? batch.coverage : new Map(),
      });
      ids.push(...logIds);
      if (!last) await new Promise((r) => setImmediate(r));
    }
    return ids;
  }

  private flushNow(): Promise<void> {
    if (
      !this.logs.length &&
      !this.documents.length &&
      !this.logUpdates.length &&
      ![...this.accumulators.values()].some((a) => !a.acc.isEmpty)
    ) {
      return Promise.resolve();
    }
    const logs = this.logs;
    const batch: WriteBatch = {
      documents: this.documents,
      logs,
      logUpdates: this.logUpdates,
      coverage: new Map(),
    };
    this.logs = [];
    this.documents = [];
    this.logUpdates = [];
    for (const [runId, a] of this.accumulators) {
      if (!a.acc.isEmpty)
        batch.coverage.set(runId, { data: a.acc.drain(), lastActivityAt: a.lastActivityAt });
    }
    this.accumulators.clear();
    const end = this.metrics.flushDuration.startTimer();
    this.flushing = this.writeInSlices(batch)
      .then((logIds) => {
        logIds.forEach((id, i) => (logs[i]!.id = id));
        for (const runId of batch.coverage.keys())
          this.versions.set(runId, (this.versions.get(runId) ?? 0) + 1);
      })
      .catch((e: Error) => {
        this.metrics.errors.inc({ component: 'storage' });
        this.log.error(
          { err: e.message, logs: batch.logs.length },
          'storage write failed; batch dropped (proxying unaffected)',
        );
      })
      .finally(() => {
        end();
        this.flushing = null;
      });
    return this.flushing;
  }
}
