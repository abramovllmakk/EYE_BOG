import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

/** Minimal shapes of the REST API used by the CLI. */
interface Ratio {
  covered: number;
  total: number;
  percent: number;
}
interface Summary {
  fields: Ratio;
  types: Ratio & { fullyCovered: number };
  operations: Ratio & { query: Ratio; mutation: Ratio; subscription: Ratio };
  arguments: Ratio;
  enumValues: Ratio;
  inputFields: Ratio;
  edges: Ratio;
  requests: {
    total: number;
    valid: number;
    invalid: number;
    introspection: number;
    unresolved: number;
  };
  tests: number;
  maxDepth: number;
}
interface SummaryResponse {
  run: {
    id: string;
    branch: string | null;
    environment: string | null;
    buildId: string | null;
    status: string;
  };
  summary: Summary;
  uncovered: { fields: string[]; operations: string[]; types: string[] };
}
interface CompareResponse {
  delta: Record<string, number>;
  newlyCovered: string[];
  lost: string[];
  schemaDiff: { added: string[]; removed: string[] } | null;
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
  err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
  env: process.env,
};

export const HELP = `gqlcov — GraphQL Coverage Proxy CLI

Usage:
  gqlcov run start [--env E] [--branch B] [--build N] [--commit SHA] [--team T] [--suite S] [--target NAME] [--id ID]
        Starts a run and prints its id (use: export GQLCOV_RUN_ID=$(gqlcov run start ...)).
  gqlcov run finish <runId> [--min-field-coverage P] [--min-operation-coverage P]
        Finishes the run, prints the summary; exit code 3 if coverage is below a threshold.
  gqlcov report <runId> [--format json|csv|markdown] [--compare BASE_RUN_ID]
  gqlcov schema upload <file.graphql> [--target NAME]

Options:
  --server URL   admin API URL (env GQLCOV_SERVER, default http://localhost:4001)
  --token T      API token (env GQLCOV_TOKEN)
`;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

function client(server: string, token: string | undefined) {
  return async function call<T>(
    method: string,
    path: string,
    body?: string | object,
    contentType?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = contentType ?? 'application/json';
    let res: Response;
    try {
      res = await fetch(server.replace(/\/$/, '') + path, {
        method,
        headers,
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
    } catch (e) {
      throw new CliError(`Cannot reach ${server}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text) as { message?: string; hint?: string };
        msg = [j.message, j.hint].filter(Boolean).join('\n') || text;
      } catch {
        /* not JSON */
      }
      throw new CliError(`${method} ${path} failed (${res.status}): ${msg}`);
    }
    return (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T;
  };
}

const p = (r: Ratio) => `${r.percent}% (${r.covered}/${r.total})`;

export function summaryText(s: SummaryResponse): string {
  const x = s.summary;
  return [
    `Run ${s.run.id}${s.run.branch ? ` [${s.run.branch}]` : ''}`,
    `  fields      ${p(x.fields)}`,
    `  types       ${p(x.types)} touched, ${x.types.fullyCovered} fully covered`,
    `  operations  ${p(x.operations)}  query ${p(x.operations.query)}, mutation ${p(x.operations.mutation)}, subscription ${p(x.operations.subscription)}`,
    `  arguments   ${p(x.arguments)}`,
    `  enum values ${p(x.enumValues)}`,
    `  input fields ${p(x.inputFields)}`,
    `  requests    ${x.requests.total} (${x.requests.invalid} invalid, ${x.requests.unresolved} unresolved), tests ${x.tests}`,
  ].join('\n');
}

export function markdownReport(s: SummaryResponse, cmp?: CompareResponse): string {
  const x = s.summary;
  const d = (k: string) => {
    const v = cmp?.delta[k];
    return v === undefined ? '' : ` | ${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  };
  const rows: [string, string, Ratio][] = [
    ['Fields', 'fields', x.fields],
    ['Types (touched)', 'types', x.types],
    ['Operations', 'operations', x.operations],
    ['Arguments', 'arguments', x.arguments],
    ['Enum values', 'enumValues', x.enumValues],
    ['Input fields', 'inputFields', x.inputFields],
  ];
  const lines = [
    `### GraphQL coverage — ${[s.run.branch, s.run.environment, s.run.buildId && `build ${s.run.buildId}`].filter(Boolean).join(', ') || s.run.id}`,
    '',
    `| Metric | Coverage | Covered / total${cmp ? ' | Δ p.p.' : ''} |`,
    `|---|---:|---:|${cmp ? '---:|' : ''}`,
    ...rows.map(
      ([label, key, r]) =>
        `| ${label} | ${r.percent}% | ${r.covered} / ${r.total}${cmp ? d(key) : ''} |`,
    ),
    '',
    `${x.requests.total} requests from ${x.tests} tests, max depth ${x.maxDepth}.`,
  ];
  if (cmp) {
    const list = (title: string, xs: string[]) =>
      xs.length
        ? [
            `<details><summary>${title} (${xs.length})</summary>`,
            '',
            ...xs.map((c) => `- \`${c}\``),
            '',
            '</details>',
          ]
        : [];
    lines.push('', ...list('Newly covered', cmp.newlyCovered), ...list('Lost coverage', cmp.lost));
    if (cmp.schemaDiff)
      lines.push(
        '',
        `Schema changed: +${cmp.schemaDiff.added.length} / −${cmp.schemaDiff.removed.length} coordinates.`,
      );
  }
  if (s.uncovered.operations.length) {
    lines.push(
      '',
      `<details><summary>Uncovered operations (${s.uncovered.operations.length})</summary>`,
      '',
      ...s.uncovered.operations.map((c) => `- \`${c}\``),
      '',
      '</details>',
    );
  }
  return lines.join('\n') + '\n';
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        server: { type: 'string' },
        token: { type: 'string' },
        env: { type: 'string' },
        branch: { type: 'string' },
        build: { type: 'string' },
        commit: { type: 'string' },
        team: { type: 'string' },
        suite: { type: 'string' },
        target: { type: 'string' },
        id: { type: 'string' },
        format: { type: 'string', default: 'markdown' },
        compare: { type: 'string' },
        'min-field-coverage': { type: 'string' },
        'min-operation-coverage': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals: pos } = parsed;
  if (o.help || pos.length === 0) {
    io.out(HELP);
    return o.help ? 0 : 2;
  }
  const call = client(
    o.server ?? io.env.GQLCOV_SERVER ?? 'http://localhost:4001',
    o.token ?? io.env.GQLCOV_TOKEN,
  );
  const threshold = (name: string, v: string | undefined) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      throw new CliError(`--${name} must be a number between 0 and 100`, 2);
    return n;
  };

  try {
    const [cmd, sub, arg] = pos;
    if (cmd === 'run' && sub === 'start') {
      const run = await call<{ id: string }>('POST', '/api/runs', {
        id: o.id,
        environment: o.env,
        branch: o.branch,
        build: o.build,
        commit: o.commit,
        team: o.team,
        testSuite: o.suite,
        target: o.target,
      });
      io.out(run.id);
      return 0;
    }
    if (cmd === 'run' && sub === 'finish') {
      if (!arg) throw new CliError('run finish requires <runId>', 2);
      const minFields = threshold('min-field-coverage', o['min-field-coverage']);
      const minOps = threshold('min-operation-coverage', o['min-operation-coverage']);
      await call('POST', `/api/runs/${encodeURIComponent(arg)}/finish`);
      const s = await call<SummaryResponse>('GET', `/api/runs/${encodeURIComponent(arg)}/summary`);
      io.out(summaryText(s));
      const failures: string[] = [];
      if (minFields !== undefined && s.summary.fields.percent < minFields) {
        failures.push(
          `field coverage ${s.summary.fields.percent}% is below the threshold ${minFields}%`,
        );
      }
      if (minOps !== undefined && s.summary.operations.percent < minOps) {
        failures.push(
          `operation coverage ${s.summary.operations.percent}% is below the threshold ${minOps}%`,
        );
      }
      if (failures.length) {
        for (const f of failures) io.err(`FAIL: ${f}`);
        return 3;
      }
      return 0;
    }
    if (cmd === 'report') {
      const runId = sub;
      if (!runId) throw new CliError('report requires <runId>', 2);
      const id = encodeURIComponent(runId);
      if (o.format === 'json' || o.format === 'csv') {
        const body = await call<unknown>('GET', `/api/runs/${id}/export?format=${o.format}`);
        io.out(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
        return 0;
      }
      if (o.format !== 'markdown') throw new CliError('--format must be json, csv or markdown', 2);
      const s = await call<SummaryResponse>('GET', `/api/runs/${id}/summary`);
      const cmp = o.compare
        ? await call<CompareResponse>(
            'GET',
            `/api/compare?base=${encodeURIComponent(o.compare)}&head=${id}`,
          )
        : undefined;
      io.out(markdownReport(s, cmp));
      return 0;
    }
    if (cmd === 'schema' && sub === 'upload') {
      if (!arg) throw new CliError('schema upload requires <file.graphql>', 2);
      let sdl: string;
      try {
        sdl = await readFile(arg, 'utf8');
      } catch (e) {
        throw new CliError(`Cannot read ${arg}: ${(e as Error).message}`, 2);
      }
      const q = o.target ? `?target=${encodeURIComponent(o.target)}` : '';
      const r = await call<{ snapshotId: number; hash: string; types: number }>(
        'POST',
        `/api/schemas/upload${q}`,
        sdl,
        'application/graphql',
      );
      io.out(
        `schema uploaded: snapshot ${r.snapshotId}, ${r.types} types, hash ${r.hash.slice(0, 12)}`,
      );
      return 0;
    }
    throw new CliError(`Unknown command: ${pos.join(' ')}\n\n${HELP}`, 2);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.message);
      return e.code;
    }
    throw e;
  }
}
