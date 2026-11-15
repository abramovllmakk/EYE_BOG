import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const headerMap = z.record(z.string(), z.string()).default({});

const targetSchema = z.object({
  /** Unique target name; proxied at `/t/<name>/graphql`. */
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'target name must be [a-zA-Z0-9_-]'),
  /** Upstream GraphQL endpoint. */
  url: z.url(),
  /** Extra proxy route for this target (the first target also gets `/graphql`). */
  route: z.string().startsWith('/').optional(),
  timeoutMs: z.number().int().positive().default(60_000),
  schema: z
    .object({
      source: z.enum(['introspection', 'sdl']).default('introspection'),
      /** SDL file for `source: sdl` (relative to the config file). */
      file: z.string().optional(),
      /** Headers for the introspection request (e.g. stand token). */
      headers: headerMap,
      /** Periodic introspection refresh, 0 = only at start / on demand. */
      refreshIntervalSec: z.number().int().nonnegative().default(0),
    })
    .prefault({}),
  headers: z
    .object({
      /** Added only if the client did not send the header. */
      add: headerMap,
      /** Always set (replaces the client's value). */
      override: headerMap,
      /** Removed before forwarding. */
      remove: z.array(z.string()).default([]),
    })
    .prefault({}),
});

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      /** Port that tests talk to (GraphQL proxy). */
      proxyPort: z.number().int().min(0).max(65535).default(4000),
      /** Port for UI, REST API, /metrics. */
      adminPort: z.number().int().min(0).max(65535).default(4001),
      bodyLimitBytes: z
        .number()
        .int()
        .positive()
        .default(50 * 1024 * 1024),
      /** Directory with the built UI (apps/web/dist). Auto-detected when omitted. */
      webDir: z.string().optional(),
    })
    .prefault({}),
  targets: z.array(targetSchema).min(1, 'at least one target is required'),
  runs: z
    .object({
      headers: z
        .object({
          runId: z.string().default('x-coverage-run-id'),
          environment: z.string().default('x-coverage-env'),
          branch: z.string().default('x-coverage-branch'),
          build: z.string().default('x-coverage-build'),
          commit: z.string().default('x-coverage-commit'),
          team: z.string().default('x-coverage-team'),
          testName: z.string().default('x-test-name'),
          testSuite: z.string().default('x-test-suite'),
        })
        .prefault({}),
      /** Header prefixes removed before forwarding to the backend. */
      stripHeaderPrefixes: z.array(z.string()).default(['x-coverage-']),
      /** Automatic runs are finished after this idle period. */
      idleTimeoutSec: z.number().int().positive().default(900),
    })
    .prefault({}),
  logging: z
    .object({
      level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
      /** Header values masked in logs and in the execution log. */
      maskHeaders: z
        .array(z.string())
        .default(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']),
      /** How variables are stored in the execution log. */
      variables: z.enum(['none', 'structure', 'full']).default('structure'),
      /** Request headers stored in the execution log (masked). */
      storeHeaders: z.boolean().default(true),
    })
    .prefault({}),
  retention: z
    .object({
      /** Raw execution log retention; aggregates are kept. 0 = keep forever. */
      operationLogDays: z.number().int().nonnegative().default(14),
      intervalSec: z.number().int().positive().default(3600),
    })
    .prefault({}),
  auth: z
    .object({
      /** Bearer token for /api (and UI). Empty = no auth. */
      token: z.string().optional(),
    })
    .prefault({}),
  coverage: z
    .object({
      propagateInterfaceCoverage: z.boolean().default(false),
    })
    .prefault({}),
  storage: z
    .object({
      driver: z.enum(['sqlite', 'postgres']).default('sqlite'),
      /** SQLite file path (relative to cwd) or postgres:// URL. */
      url: z.string().default('./data/gqlcov.db'),
    })
    .prefault({}),
  queue: z
    .object({
      maxSize: z.number().int().positive().default(10_000),
      batchSize: z.number().int().positive().default(200),
      flushIntervalMs: z.number().int().positive().default(500),
      /** Max response bytes inspected for the `has_errors` flag. */
      responseInspectLimitBytes: z
        .number()
        .int()
        .nonnegative()
        .default(1024 * 1024),
    })
    .prefault({}),
  cache: z
    .object({
      /** LRU size of parsed + validated documents. */
      documents: z.number().int().positive().default(2000),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type TargetConfig = Config['targets'][number];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const camel = (s: string) =>
  s.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function coerceScalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') || v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Apply env overrides: `GQLCOV_<SECTION>__<KEY>` (nested by `__`, keys camelCased,
 * numeric segments index arrays), e.g. `GQLCOV_SERVER__PROXY_PORT=8080`,
 * `GQLCOV_TARGETS__0__URL=http://api/graphql`. Shortcuts: `TARGET_URL`, `AUTH_TOKEN`, `DATABASE_URL`.
 */
export function applyEnv(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const out = structuredClone(raw);
  const set = (path: string[], value: unknown) => {
    let cur: Record<string, unknown> | unknown[] = out;
    path.forEach((seg, i) => {
      const key: string | number = /^\d+$/.test(seg) ? Number(seg) : seg;
      const last = i === path.length - 1;
      const container = cur as Record<string | number, unknown>;
      if (last) {
        container[key] = value;
        return;
      }
      const nextIsIndex = /^\d+$/.test(path[i + 1]!);
      if (container[key] === undefined || container[key] === null)
        container[key] = nextIsIndex ? [] : {};
      cur = container[key] as Record<string, unknown>;
    });
  };
  if (env.TARGET_URL) set(['targets', '0', 'url'], env.TARGET_URL);
  if (env.TARGET_URL && !(out.targets as { name?: string }[])[0]?.name)
    set(['targets', '0', 'name'], 'default');
  if (env.AUTH_TOKEN) set(['auth', 'token'], env.AUTH_TOKEN);
  if (env.DATABASE_URL) {
    set(['storage', 'url'], env.DATABASE_URL);
    if (/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) set(['storage', 'driver'], 'postgres');
  }
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('GQLCOV_') || v === undefined || k === 'GQLCOV_CONFIG') continue;
    set(
      k
        .slice('GQLCOV_'.length)
        .split('__')
        .map((s) => (/^\d+$/.test(s) ? s : camel(s))),
      coerceScalar(v),
    );
  }
  return out;
}

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export interface LoadedConfig {
  config: Config;
  /** Directory of the config file (for relative paths), or cwd. */
  baseDir: string;
}

export function parseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = {},
  baseDir = process.cwd(),
): LoadedConfig {
  const withEnv = applyEnv((raw ?? {}) as Record<string, unknown>, env);
  const parsed = configSchema.safeParse(withEnv);
  if (!parsed.success)
    throw new ConfigError(`Invalid configuration:\n${formatIssues(parsed.error)}`);
  const config = parsed.data;
  const names = new Set<string>();
  for (const t of config.targets) {
    if (names.has(t.name))
      throw new ConfigError(
        `Invalid configuration:\n  - targets: duplicate target name "${t.name}"`,
      );
    names.add(t.name);
    if (t.schema.source === 'sdl' && !t.schema.file) {
      throw new ConfigError(
        `Invalid configuration:\n  - targets.${t.name}.schema.file: required when source is "sdl"`,
      );
    }
  }
  return { config, baseDir };
}

/** Load YAML config from `path` (or `GQLCOV_CONFIG`, or ./gqlcov.yaml if present) + env overrides. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const file = path ?? env.GQLCOV_CONFIG ?? (existsSync('gqlcov.yaml') ? 'gqlcov.yaml' : undefined);
  let raw: unknown = {};
  let baseDir = process.cwd();
  if (file) {
    const abs = resolve(file);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      throw new ConfigError(`Cannot read config file ${abs}: ${(e as Error).message}`);
    }
    try {
      raw = parseYaml(text) ?? {};
    } catch (e) {
      throw new ConfigError(`Config file ${abs} is not valid YAML: ${(e as Error).message}`);
    }
    baseDir = dirname(abs);
  }
  return parseConfig(raw, env, baseDir);
}
