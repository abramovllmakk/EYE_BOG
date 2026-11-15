import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertValidSchema,
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  type GraphQLSchema,
  type IntrospectionQuery,
} from 'graphql';
import { request } from 'undici';
import { buildSchemaModel, normalizeSdl, type SchemaModel } from '@gqlcov/core';
import type { Logger } from 'pino';
import type { Config, TargetConfig } from './config.js';
import type { SnapshotRow, Storage } from './storage/storage.js';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface LoadedSchema {
  snapshotId: number;
  hash: string;
  schema: GraphQLSchema;
  model: SchemaModel;
  source: string;
  loadedAt: number;
}

export class SchemaLoadError extends Error {
  override name = 'SchemaLoadError';
  constructor(
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

const UPLOAD_HINT =
  'Upload the SDL instead: `gqlcov schema upload schema.graphql --target <name>` or POST /api/schemas/upload, ' +
  'or set `schema.source: sdl` with `schema.file` in the config.';

/** Fetch a schema via introspection (throws SchemaLoadError with a hint when disabled). */
export async function introspect(target: TargetConfig): Promise<GraphQLSchema> {
  let res;
  try {
    res = await request(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...target.schema.headers,
      },
      body: JSON.stringify({
        query: getIntrospectionQuery({ inputValueDeprecation: true }),
        operationName: 'IntrospectionQuery',
      }),
      headersTimeout: target.timeoutMs,
      bodyTimeout: target.timeoutMs,
    });
  } catch (e) {
    throw new SchemaLoadError(
      `Introspection request to ${target.url} failed: ${(e as Error).message}`,
      UPLOAD_HINT,
    );
  }
  const text = await res.body.text();
  let payload: { data?: IntrospectionQuery; errors?: { message: string }[] };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SchemaLoadError(
      `Introspection to ${target.url} returned HTTP ${res.statusCode} with a non-JSON body`,
      UPLOAD_HINT,
    );
  }
  if (!payload.data?.__schema) {
    const msg = payload.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.statusCode}`;
    throw new SchemaLoadError(
      `Introspection is disabled or failed on ${target.url}: ${msg}`,
      UPLOAD_HINT,
    );
  }
  return buildClientSchema(payload.data);
}

export function parseSdl(sdl: string): GraphQLSchema {
  let schema: GraphQLSchema;
  try {
    schema = buildSchema(sdl);
    assertValidSchema(schema);
  } catch (e) {
    throw new SchemaLoadError(`Invalid SDL: ${(e as Error).message}`);
  }
  return schema;
}

/** Current schema per target; snapshots are persisted and versioned by normalized-SDL hash. */
export class SchemaRegistry {
  private readonly current = new Map<string, LoadedSchema>();
  private readonly byId = new Map<number, LoadedSchema>();
  private readonly errors = new Map<string, { message: string; hint: string | null; at: number }>();
  private timers: NodeJS.Timeout[] = [];
  private listeners: ((target: string, s: LoadedSchema) => void)[] = [];

  constructor(
    private readonly config: Config,
    private readonly baseDir: string,
    private readonly storage: Storage,
    private readonly log: Logger,
  ) {}

  get(target: string): LoadedSchema | undefined {
    return this.current.get(target);
  }

  lastError(target: string) {
    return this.errors.get(target) ?? null;
  }

  onChange(fn: (target: string, s: LoadedSchema) => void): void {
    this.listeners.push(fn);
  }

  targetConfig(name: string): TargetConfig {
    const t = this.config.targets.find((x) => x.name === name);
    if (!t) throw new SchemaLoadError(`Unknown target "${name}"`);
    return t;
  }

  /** Load a snapshot by id (cached), e.g. the schema version a run was recorded against. */
  async byIdOrNull(id: number): Promise<LoadedSchema | null> {
    const cached = this.byId.get(id);
    if (cached) return cached;
    const row = await this.storage.getSnapshot(id);
    if (!row) return null;
    return this.remember(row, buildSchema(row.sdl));
  }

  private remember(row: SnapshotRow, schema: GraphQLSchema): LoadedSchema {
    const loaded: LoadedSchema = {
      snapshotId: row.id,
      hash: row.hash,
      schema,
      model: buildSchemaModel(schema),
      source: row.source,
      loadedAt: Date.now(),
    };
    this.byId.set(row.id, loaded);
    return loaded;
  }

  private async activate(
    target: string,
    schema: GraphQLSchema,
    source: string,
  ): Promise<LoadedSchema> {
    const sdl = normalizeSdl(schema);
    const hash = sha256(sdl);
    const prev = this.current.get(target);
    if (prev?.hash === hash) return prev;
    const row = await this.storage.saveSnapshot({ target, hash, sdl, source });
    // Re-build from normalized SDL so the in-memory schema matches what is stored.
    const loaded = this.remember(row, buildSchema(sdl));
    this.current.set(target, loaded);
    this.errors.delete(target);
    this.log.info(
      { target, hash: hash.slice(0, 12), source, snapshotId: row.id },
      'schema activated',
    );
    for (const fn of this.listeners) fn(target, loaded);
    return loaded;
  }

  async refresh(target: string): Promise<LoadedSchema> {
    const t = this.targetConfig(target);
    try {
      if (t.schema.source === 'sdl') {
        const sdl = await readFile(resolve(this.baseDir, t.schema.file!), 'utf8');
        return await this.activate(target, parseSdl(sdl), 'file');
      }
      return await this.activate(target, await introspect(t), 'introspection');
    } catch (e) {
      const err = e instanceof SchemaLoadError ? e : new SchemaLoadError((e as Error).message);
      this.errors.set(target, { message: err.message, hint: err.hint, at: Date.now() });
      throw err;
    }
  }

  async upload(target: string, sdl: string): Promise<LoadedSchema> {
    this.targetConfig(target);
    return this.activate(target, parseSdl(sdl), 'upload');
  }

  /**
   * Initial load for every target. On failure fall back to the latest stored snapshot,
   * so the proxy keeps counting coverage when the backend is temporarily down.
   */
  async start(): Promise<void> {
    for (const t of this.config.targets) {
      try {
        await this.refresh(t.name);
      } catch (e) {
        const err = e as SchemaLoadError;
        const latest = await this.storage.latestSnapshot(t.name);
        if (latest) {
          const loaded = this.remember(latest, buildSchema(latest.sdl));
          this.current.set(t.name, loaded);
          this.log.warn(
            { target: t.name, err: err.message },
            'schema load failed, using latest stored snapshot',
          );
        } else {
          this.log.error(
            { target: t.name, err: err.message, hint: err.hint },
            'schema load failed; coverage is not counted until a schema is available',
          );
        }
      }
      if (t.schema.refreshIntervalSec > 0) {
        const timer = setInterval(() => {
          this.refresh(t.name).catch((e: Error) =>
            this.log.warn({ target: t.name, err: e.message }, 'schema refresh failed'),
          );
        }, t.schema.refreshIntervalSec * 1000);
        timer.unref();
        this.timers.push(timer);
      }
    }
  }

  /** Retry loading targets that have no schema yet (called lazily by the pipeline). */
  async ensure(target: string): Promise<LoadedSchema | undefined> {
    const cur = this.current.get(target);
    if (cur) return cur;
    const err = this.errors.get(target);
    if (err && Date.now() - err.at < 10_000) return undefined;
    try {
      return await this.refresh(target);
    } catch {
      return undefined;
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
