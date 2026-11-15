import type { GraphQLRequest } from './types.js';

export interface ParsedHttpRequest {
  batch: boolean;
  requests: GraphQLRequest[];
}

export type ParseOutcome = ParsedHttpRequest | { error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function toRequest(raw: unknown): GraphQLRequest | null {
  if (!isRecord(raw)) return null;
  const pick = <T>(v: unknown, ok: (x: unknown) => x is T): T | null => (ok(v) ? v : null);
  return {
    query: pick(raw.query, (x): x is string => typeof x === 'string'),
    operationName: pick(raw.operationName, (x): x is string => typeof x === 'string'),
    variables: pick(raw.variables, isRecord),
    extensions: pick(raw.extensions, isRecord),
  };
}

/** Parse a JSON body (`application/json`) or multipart `operations` field. */
export function parseOperationsJson(text: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Body is not valid JSON' };
  }
  if (Array.isArray(parsed)) {
    const requests = parsed.map(toRequest);
    if (requests.some((r) => r === null)) return { error: 'Batch must contain objects' };
    return { batch: true, requests: requests as GraphQLRequest[] };
  }
  const single = toRequest(parsed);
  return single
    ? { batch: false, requests: [single] }
    : { error: 'Body must be an object or array' };
}

function parseJsonParam(v: string | undefined): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface HttpRequestInput {
  method: string;
  contentType?: string | undefined;
  /** Raw body text (not used for GET). */
  body?: string | undefined;
  /** URL search params. */
  query?: Record<string, string | undefined>;
}

/**
 * Classify a GraphQL-over-HTTP request: POST JSON (single or batch), POST application/graphql,
 * GET with query params. Multipart is handled by the caller via `parseOperationsJson`.
 */
export function parseHttpGraphQLRequest(input: HttpRequestInput): ParseOutcome {
  const method = input.method.toUpperCase();
  if (method === 'GET') {
    const q = input.query ?? {};
    if (!q.query && !q.extensions) return { error: 'GET request without query' };
    return {
      batch: false,
      requests: [
        {
          query: q.query ?? null,
          operationName: q.operationName ?? null,
          variables: parseJsonParam(q.variables),
          extensions: parseJsonParam(q.extensions),
        },
      ],
    };
  }
  if (method !== 'POST') return { error: `Unsupported method ${method}` };
  const ct = (input.contentType ?? '').toLowerCase();
  if (ct.startsWith('application/graphql') && !ct.includes('json')) {
    return { batch: false, requests: [{ query: input.body ?? '' }] };
  }
  return parseOperationsJson(input.body ?? '');
}

/** Automatic Persisted Queries hash (`extensions.persistedQuery.sha256Hash`). */
export function persistedQueryHash(req: GraphQLRequest): string | null {
  const pq = req.extensions?.persistedQuery;
  if (!isRecord(pq)) return null;
  return typeof pq.sha256Hash === 'string' ? pq.sha256Hash : null;
}
