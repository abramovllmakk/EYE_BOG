import { decodeHeaderValue } from './http.js';

export type VariablesPolicy = 'none' | 'structure' | 'full';

export const MASK = '***';

/** Keys that are always masked even with policy `full`. */
export const DEFAULT_SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i;

function structureOf(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(structureOf);
  if (typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, structureOf(x)]),
    );
  }
  return `<${typeof v}>`;
}

function maskSecrets(v: unknown, pattern: RegExp): unknown {
  if (Array.isArray(v)) return v.map((x) => maskSecrets(x, pattern));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        pattern.test(k) ? MASK : maskSecrets(x, pattern),
      ]),
    );
  }
  return v;
}

/**
 * Redact variables for the execution log.
 *  - `none`: drop entirely;
 *  - `structure` (default): keep shape, replace leaf values by their JSON type (`<string>`);
 *  - `full`: keep values, but mask secret-looking keys.
 */
export function redactVariables(
  variables: Record<string, unknown> | null | undefined,
  policy: VariablesPolicy,
  secretKeyPattern: RegExp = DEFAULT_SECRET_KEY_PATTERN,
): Record<string, unknown> | null {
  if (!variables || policy === 'none') return null;
  if (policy === 'structure') return structureOf(variables) as Record<string, unknown>;
  return maskSecrets(variables, secretKeyPattern) as Record<string, unknown>;
}

/** Mask header values (case-insensitive names). Multi-value headers are joined. */
export function maskHeaders(
  headers: Record<string, string | string[] | undefined>,
  masked: readonly string[],
): Record<string, string> {
  const set = new Set(masked.map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = set.has(k.toLowerCase())
      ? MASK
      : (decodeHeaderValue(Array.isArray(v) ? v.join(', ') : v) as string);
  }
  return out;
}
