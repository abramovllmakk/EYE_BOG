import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  diffSchemaModels,
  parseTestKey,
  type CoverageReport,
  type CoverageSummary,
  type TypeCoverage,
} from '@gqlcov/core';
import type { Config } from './config.js';
import { CoverageService, NotFoundError } from './coverage-service.js';
import type { AnalysisPipeline } from './pipeline.js';
import type { RunManager } from './runs.js';
import { SchemaLoadError, type SchemaRegistry } from './schema-registry.js';
import type { RunRow, Storage } from './storage/storage.js';

export interface ApiContext {
  config: Config;
  storage: Storage;
  schemas: SchemaRegistry;
  runs: RunManager;
  pipeline: AnalysisPipeline;
  coverage: CoverageService;
}

const str = z.string().trim().min(1).optional();
const dateParam = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (Number.isNaN(n)) {
      ctx.addIssue({ code: 'custom', message: 'expected ISO date or epoch ms' });
      return z.NEVER;
    }
    return n;
  });

const runFilters = z.object({
  target: str,
  environment: str,
  branch: str,
  team: str,
  testSuite: str,
  build: str,
  status: z.enum(['running', 'finished']).optional(),
  from: dateParam,
  to: dateParam,
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const runIdParams = z.object({ id: z.string().min(1) });

export interface CompactSummary {
  fields: number;
  types: number;
  operations: number;
  arguments: number;
  enumValues: number;
  inputFields: number;
  edges: number;
}

export const compact = (s: CoverageSummary): CompactSummary => ({
  fields: s.fields.percent,
  types: s.types.percent,
  operations: s.operations.percent,
  arguments: s.arguments.percent,
  enumValues: s.enumValues.percent,
  inputFields: s.inputFields.percent,
  edges: s.edges.percent,
});

function filterTypes(
  report: CoverageReport,
  q: {
    kind?: string | undefined;
    status?: string | undefined;
    search?: string | undefined;
    type?: string | undefined;
  },
): TypeCoverage[] {
  const search = q.search?.toLowerCase();
  return report.types
    .filter((t) => !q.type || t.name === q.type)
    .filter((t) => !q.kind || t.kind === q.kind)
    .map((t) => {
      let fields = t.fields;
      if (q.status) {
        fields = fields.filter((f) =>
          q.status === 'covered'
            ? f.counted
            : q.status === 'uncovered'
              ? !f.counted
              : f.status === q.status,
        );
      }
      if (search && !t.name.toLowerCase().includes(search)) {
        fields = fields.filter((f) => f.coordinate.toLowerCase().includes(search));
      }
      return { ...t, fields };
    })
    .filter((t) => {
      if (search && !t.name.toLowerCase().includes(search) && t.fields.length === 0) return false;
      if (q.status && (t.kind === 'OBJECT' || t.kind === 'INTERFACE')) return t.fields.length > 0;
      if (q.status === 'covered') return t.status === 'covered';
      if (q.status === 'uncovered') return t.status !== 'covered';
      return true;
    });
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function registerApi(root: FastifyInstance, ctx: ApiContext): void {
  const { storage, schemas, runs, pipeline, coverage, config } = ctx;
  const app = root.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError)
      return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof SchemaLoadError) {
      return reply
        .code(422)
        .send({ error: 'schema_load_failed', message: err.message, hint: err.hint });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.code(400).send({ error: 'bad_request', message: e.message });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    root.log.error({ err: e.message }, 'api error');
    return reply.code(500).send({ error: 'internal', message: e.message });
  });

  const withSummary = async (run: RunRow) => {
    try {
      const rc = await coverage.coverage(run.id);
      return { ...run, summary: compact(rc.report.summary) };
    } catch {
      return { ...run, summary: null };
    }
  };

  // --- meta ------------------------------------------------------------------

  app.get(
    '/api/targets',
    { schema: { tags: ['meta'], summary: 'Configured proxy targets and schema status' } },
    async () =>
      config.targets.map((t) => {
        const s = schemas.get(t.name);
        return {
          name: t.name,
          url: t.url,
          schemaSource: t.schema.source,
          proxyPath: t === config.targets[0] ? '/graphql' : `/t/${t.name}/graphql`,
          schema: s
            ? { snapshotId: s.snapshotId, hash: s.hash, source: s.source, loadedAt: s.loadedAt }
            : null,
          error: schemas.lastError(t.name),
        };
      }),
  );

  app.get(
    '/api/filters',
    { schema: { tags: ['meta'], summary: 'Distinct filter values (environments, branches, …)' } },
    async () => storage.distinctValues(),
  );

  // --- schemas -----------------------------------------------------------------

  app.get(
    '/api/schemas',
    {
      schema: {
        tags: ['schemas'],
        summary: 'List schema snapshots',
        querystring: z.object({ target: str }),
      },
    },
    async (req) => {
      const items = await storage.listSnapshots(req.query.target);
      return items.map((s) => ({ ...s, current: schemas.get(s.target)?.snapshotId === s.id }));
    },
  );

  app.get(
    '/api/schemas/:sid',
    {
      schema: {
        tags: ['schemas'],
        summary: 'Snapshot with SDL and graph model',
        params: z.object({ sid: z.coerce.number().int() }),
      },
    },
    async (req) => {
      const row = await storage.getSnapshot(req.params.sid);
      if (!row) throw new NotFoundError(`Schema snapshot ${req.params.sid} not found`);
      const loaded = await schemas.byIdOrNull(row.id);
      return { ...row, model: loaded!.model };
    },
  );

  const uploadBody = z.object({ target: str, sdl: z.string().min(1) });
  app.post(
    '/api/schemas',
    { schema: { tags: ['schemas'], summary: 'Upload SDL (JSON body)', body: uploadBody } },
    async (req) => {
      const s = await schemas.upload(req.body.target ?? config.targets[0]!.name, req.body.sdl);
      return { snapshotId: s.snapshotId, hash: s.hash, types: s.model.types.length };
    },
  );

  app.post(
    '/api/schemas/upload',
    {
      schema: {
        tags: ['schemas'],
        summary: 'Upload SDL as raw text (text/plain or application/graphql) or JSON {sdl}',
        querystring: z.object({ target: str }),
      },
    },
    async (req) => {
      const body = req.body as unknown;
      const sdl = typeof body === 'string' ? body : (body as { sdl?: string } | null)?.sdl;
      if (!sdl) throw Object.assign(new Error('SDL body required'), { statusCode: 400 });
      const target =
        req.query.target ?? (body as { target?: string } | null)?.target ?? config.targets[0]!.name;
      const s = await schemas.upload(target, sdl);
      return { snapshotId: s.snapshotId, hash: s.hash, types: s.model.types.length };
    },
  );

  app.post(
    '/api/schemas/refresh',
    {
      schema: {
        tags: ['schemas'],
        summary: 'Re-run introspection (or re-read SDL file)',
        body: z.object({ target: str }).optional(),
      },
    },
    async (req) => {
      const s = await schemas.refresh(req.body?.target ?? config.targets[0]!.name);
      return { snapshotId: s.snapshotId, hash: s.hash, types: s.model.types.length };
    },
  );

  app.get(
    '/api/schemas/diff',
    {
      schema: {
        tags: ['schemas'],
        summary: 'Diff two schema snapshots',
        querystring: z.object({ base: z.coerce.number().int(), head: z.coerce.number().int() }),
      },
    },
    async (req) => {
      const [b, h] = await Promise.all([
        schemas.byIdOrNull(req.query.base),
        schemas.byIdOrNull(req.query.head),
      ]);
      if (!b || !h) throw new NotFoundError('Schema snapshot not found');
      return diffSchemaModels(b.model, h.model);
    },
  );

  // --- runs ------------------------------------------------------------------

  app.get(
    '/api/runs',
    {
      schema: {
        tags: ['runs'],
        summary: 'List runs with key percentages',
        querystring: runFilters,
      },
    },
    async (req) => {
      const q = req.query;
      const { items, total } = await storage.listRuns({ ...q, buildId: q.build });
      return { items: await Promise.all(items.map(withSummary)), total };
    },
  );

  app.post(
    '/api/runs',
    {
      schema: {
        tags: ['runs'],
        summary:
          'Start a run (explicit lifecycle). Proxied requests without a run id go to the latest started run.',
        body: z
          .object({
            id: str,
            target: str,
            environment: str,
            branch: str,
            commit: str,
            build: str,
            team: str,
            testSuite: str,
            labels: z.record(z.string(), z.string()).optional(),
          })
          .default({}),
      },
    },
    async (req, reply) => {
      const run = await runs.create(req.body);
      return reply.code(201).send(run);
    },
  );

  app.get('/api/runs/:id', { schema: { tags: ['runs'], params: runIdParams } }, async (req) =>
    withSummary(await coverage.getRun(req.params.id)),
  );

  app.post(
    '/api/runs/:id/finish',
    {
      schema: {
        tags: ['runs'],
        summary: 'Finish a run (flushes pending analysis first)',
        params: runIdParams,
      },
    },
    async (req) => {
      await coverage.getRun(req.params.id);
      await pipeline.idle();
      await runs.finish(req.params.id);
      const rc = await coverage.coverage(req.params.id);
      return { run: rc.run, summary: rc.report.summary };
    },
  );

  app.get(
    '/api/runs/:id/summary',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Run summary: percentages and uncovered lists',
        params: runIdParams,
        querystring: z.object({ testSuite: str }),
      },
    },
    async (req) => {
      const rc = await coverage.coverage(req.params.id, { testSuite: req.query.testSuite });
      return {
        run: rc.run,
        schema: { snapshotId: rc.schema.snapshotId, hash: rc.schema.hash },
        summary: rc.report.summary,
        uncovered: rc.report.uncovered,
      };
    },
  );

  app.get(
    '/api/runs/:id/schema',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Graph model of the schema version of the run',
        params: runIdParams,
      },
    },
    async (req) => {
      const run = await coverage.getRun(req.params.id);
      const s = await coverage.schemaFor(run);
      if (!s) throw new NotFoundError('No schema for run');
      return { snapshotId: s.snapshotId, hash: s.hash, ...s.model };
    },
  );

  app.get(
    '/api/runs/:id/coverage',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Coverage by type and field',
        params: runIdParams,
        querystring: z.object({
          type: str,
          kind: z.enum(['OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT']).optional(),
          status: z.enum(['covered', 'uncovered', 'partial', 'via_interface']).optional(),
          search: str,
          testSuite: str,
        }),
      },
    },
    async (req) => {
      const rc = await coverage.coverage(req.params.id, { testSuite: req.query.testSuite });
      return { summary: rc.report.summary, types: filterTypes(rc.report, req.query) };
    },
  );

  app.get(
    '/api/runs/:id/types/:name',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Type detail',
        params: z.object({ id: z.string(), name: z.string() }),
      },
    },
    async (req) => {
      const rc = await coverage.coverage(req.params.id);
      const t = rc.report.types.find((x) => x.name === req.params.name);
      const model = rc.schema.model.types.find((x) => x.name === req.params.name);
      if (!model) throw new NotFoundError(`Type ${req.params.name} not in schema`);
      const fieldTests: Record<string, string[]> = {};
      for (const f of t?.fields ?? []) {
        fieldTests[f.name] = Object.keys(rc.data.fields[f.coordinate]?.tests ?? {}).sort();
      }
      return {
        type: t ?? null,
        model,
        fieldTests,
        referencedBy: rc.schema.model.edges
          .filter((e) => e.to === model.name && e.kind === 'field')
          .map((e) => e.id),
      };
    },
  );

  app.get(
    '/api/runs/:id/fields/:coordinate',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Field detail: counters, tests, paths, sample operations',
        params: z.object({
          id: z.string(),
          coordinate: z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*\.[_A-Za-z][_0-9A-Za-z]*$/),
        }),
      },
    },
    async (req) => {
      const { id, coordinate } = req.params;
      const rc = await coverage.coverage(id);
      const [typeName, fieldName] = coordinate.split('.') as [string, string];
      const type = rc.report.types.find((t) => t.name === typeName);
      const field = type?.fields.find((f) => f.name === fieldName);
      const model = rc.schema.model.types
        .find((t) => t.name === typeName)
        ?.fields.find((f) => f.name === fieldName);
      if (!model || !field) throw new NotFoundError(`Field ${coordinate} not in schema`);
      const hit = rc.data.fields[coordinate];
      const tests = (await storage.fieldTests(id, coordinate)).map((t) => ({
        ...t,
        ...parseTestKey(t.testKey),
      }));
      const ops = await storage.listOperations(id, { coordinate, limit: 20 });
      return {
        coordinate,
        typeName,
        model,
        coverage: field,
        hit: hit
          ? {
              ...hit,
              paths: Object.entries(hit.paths)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([path, requests]) => ({ path, requests })),
            }
          : null,
        tests,
        operations: ops,
      };
    },
  );

  app.get(
    '/api/runs/:id/tests',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Tests seen in the run (test → fields)',
        params: runIdParams,
      },
    },
    async (req) => {
      await coverage.getRun(req.params.id);
      return storage.listTests(req.params.id);
    },
  );

  app.get(
    '/api/runs/:id/tests/:testKey/fields',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Fields covered by one test',
        params: z.object({ id: z.string(), testKey: z.string() }),
      },
    },
    async (req) => {
      const rc = await coverage.coverage(req.params.id);
      return Object.entries(rc.data.fields)
        .filter(([, f]) => req.params.testKey in f.tests)
        .map(([c, f]) => ({ coordinate: c, requests: f.tests[req.params.testKey]! }))
        .sort((a, b) => a.coordinate.localeCompare(b.coordinate));
    },
  );

  app.get(
    '/api/runs/:id/operations',
    {
      schema: {
        tags: ['operations'],
        summary: 'Execution log of a run',
        params: runIdParams,
        querystring: z.object({
          test: str,
          status: z.enum(['valid', 'invalid', 'unresolved', 'no_schema']).optional(),
          search: str,
          coordinate: str,
          limit: z.coerce.number().int().min(1).max(500).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      await coverage.getRun(req.params.id);
      const q = req.query;
      return storage.listOperations(req.params.id, { ...q, testName: q.test });
    },
  );

  app.get(
    '/api/operations/:logId',
    {
      schema: {
        tags: ['operations'],
        summary: 'One logged operation with query text',
        params: z.object({ logId: z.coerce.number().int() }),
      },
    },
    async (req) => {
      const op = await storage.getOperation(req.params.logId);
      if (!op) throw new NotFoundError(`Operation ${req.params.logId} not found`);
      const doc = op.queryHash ? await storage.getQueryDocument(op.queryHash) : null;
      return { ...op, query: doc?.query ?? null, normalizedQuery: doc?.normalized ?? null };
    },
  );

  // --- compare / export / timeline ---------------------------------------------

  app.get(
    '/api/compare',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Compare two runs: newly covered / lost fields and schema diff',
        querystring: z.object({ base: z.string(), head: z.string() }),
      },
    },
    async (req) => {
      const [b, h] = await Promise.all([
        coverage.coverage(req.query.base),
        coverage.coverage(req.query.head),
      ]);
      const covered = (r: CoverageReport) =>
        new Set(r.types.flatMap((t) => t.fields.filter((f) => f.counted).map((f) => f.coordinate)));
      const bc = covered(b.report);
      const hc = covered(h.report);
      const schemaDiff =
        b.schema.snapshotId === h.schema.snapshotId
          ? null
          : diffSchemaModels(b.schema.model, h.schema.model);
      const removed = new Set(schemaDiff?.removed ?? []);
      const delta = (x: number, y: number) => Math.round((y - x) * 10) / 10;
      const bs = compact(b.report.summary);
      const hs = compact(h.report.summary);
      return {
        base: { run: b.run, summary: bs },
        head: { run: h.run, summary: hs },
        delta: Object.fromEntries(
          Object.keys(bs).map((k) => [
            k,
            delta(bs[k as keyof CompactSummary], hs[k as keyof CompactSummary]),
          ]),
        ),
        newlyCovered: [...hc].filter((c) => !bc.has(c)).sort(),
        lost: [...bc].filter((c) => !hc.has(c) && !removed.has(c)).sort(),
        removedFromSchema: [...bc].filter((c) => removed.has(c)).sort(),
        schemaDiff,
      };
    },
  );

  app.get(
    '/api/runs/:id/export',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Export coverage as JSON or CSV',
        params: runIdParams,
        querystring: z.object({ format: z.enum(['json', 'csv']).default('json') }),
      },
    },
    async (req, reply) => {
      const rc = await coverage.coverage(req.params.id);
      const name = `coverage-${req.params.id}`;
      if (req.query.format === 'json') {
        reply.header('content-disposition', `attachment; filename="${name}.json"`);
        return {
          run: rc.run,
          schemaHash: rc.schema.hash,
          summary: rc.report.summary,
          types: rc.report.types,
          uncovered: rc.report.uncovered,
        };
      }
      const rows = [
        [
          'coordinate',
          'type',
          'kind',
          'field',
          'status',
          'requests',
          'occurrences',
          'tests',
          'max_depth',
        ],
      ];
      for (const t of rc.report.types) {
        for (const f of t.fields) {
          rows.push([
            f.coordinate,
            t.name,
            t.kind,
            f.name,
            f.status,
            String(f.requests),
            String(f.occurrences),
            String(f.tests),
            String(f.maxDepth ?? ''),
          ]);
        }
        for (const v of t.values) {
          rows.push([
            v.coordinate,
            t.name,
            t.kind,
            v.name,
            v.used ? 'covered' : 'uncovered',
            String(v.requests),
            '',
            '',
            '',
          ]);
        }
      }
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}.csv"`);
      return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
    },
  );

  app.get(
    '/api/teams',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Coverage per team: union of all its runs (per target) within the filters',
        querystring: z.object({
          target: str,
          environment: str,
          branch: str,
          from: dateParam,
          to: dateParam,
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const { items } = await storage.listRuns({ ...q, limit: 500 });
      const groups = new Map<string, RunRow[]>();
      for (const r of items) {
        const key = JSON.stringify([r.team, r.target]);
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
      }
      const out = [];
      for (const runs of groups.values()) {
        const agg = await coverage.aggregate(runs);
        if (!agg) continue;
        const s = agg.report.summary;
        out.push({
          team: runs[0]!.team,
          target: runs[0]!.target,
          runs: runs.length,
          lastRunAt: Math.max(...runs.map((r) => r.startedAt)),
          requests: s.requests.total,
          tests: s.tests,
          summary: compact(s),
          uncovered: {
            fields: agg.report.uncovered.fields.length,
            operations: agg.report.uncovered.operations,
          },
        });
      }
      // Named teams first (alphabetically), runs without a team last.
      return out.sort(
        (a, b) =>
          (a.team === null ? 1 : 0) - (b.team === null ? 1 : 0) ||
          String(a.team).localeCompare(String(b.team)) ||
          a.target.localeCompare(b.target),
      );
    },
  );

  app.get(
    '/api/timeline',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Coverage percentages over runs (oldest first)',
        querystring: runFilters.omit({ offset: true }),
      },
    },
    async (req) => {
      const q = req.query;
      const { items } = await storage.listRuns({ ...q, buildId: q.build, limit: q.limit });
      const points = await Promise.all(items.map(withSummary));
      return points
        .filter((p) => p.summary)
        .reverse()
        .map((p) => ({
          runId: p.id,
          startedAt: p.startedAt,
          branch: p.branch,
          environment: p.environment,
          buildId: p.buildId,
          summary: p.summary,
        }));
    },
  );

  app.get(
    '/api/runs/:id/groups',
    {
      schema: {
        tags: ['coverage'],
        summary: 'Coverage grouped by test suite',
        params: runIdParams,
      },
    },
    async (req) => {
      const tests = await storage.listTests(req.params.id);
      const suites = [...new Set(tests.map((t) => t.suite).filter((s): s is string => !!s))].sort();
      const out = [];
      for (const suite of suites) {
        const rc = await coverage.coverage(req.params.id, { testSuite: suite });
        out.push({
          suite,
          tests: tests.filter((t) => t.suite === suite).length,
          summary: compact(rc.report.summary),
        });
      }
      return out;
    },
  );
}
