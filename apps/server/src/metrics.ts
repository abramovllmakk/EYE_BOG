import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type Metrics = ReturnType<typeof createMetrics>;

/** Prometheus metrics (own registry per app instance). */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'gqlcov_' });
  return {
    registry,
    proxyRequests: new Counter({
      name: 'gqlcov_proxy_requests_total',
      help: 'Proxied HTTP requests',
      labelNames: ['target', 'status'] as const,
      registers: [registry],
    }),
    proxyOverhead: new Histogram({
      name: 'gqlcov_proxy_overhead_seconds',
      help: 'Time spent in the proxy excluding the upstream round trip',
      labelNames: ['target'] as const,
      buckets: [0.0005, 0.001, 0.002, 0.003, 0.005, 0.01, 0.025, 0.05, 0.1],
      registers: [registry],
    }),
    upstreamDuration: new Histogram({
      name: 'gqlcov_upstream_duration_seconds',
      help: 'Upstream (backend) round trip until the response body ends',
      labelNames: ['target'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    upstreamErrors: new Counter({
      name: 'gqlcov_upstream_errors_total',
      help: 'Upstream connection errors (answered with 502)',
      labelNames: ['target'] as const,
      registers: [registry],
    }),
    queueLength: new Gauge({
      name: 'gqlcov_analysis_queue_length',
      help: 'Requests waiting for analysis',
      registers: [registry],
    }),
    dropped: new Counter({
      name: 'gqlcov_analysis_dropped_total',
      help: 'Requests not analysed because the queue was full',
      registers: [registry],
    }),
    analyzed: new Counter({
      name: 'gqlcov_analyzed_operations_total',
      help: 'Analysed GraphQL operations by status',
      labelNames: ['status'] as const,
      registers: [registry],
    }),
    errors: new Counter({
      name: 'gqlcov_errors_total',
      help: 'Internal errors (fail-open: never affect proxying)',
      labelNames: ['component'] as const,
      registers: [registry],
    }),
    flushDuration: new Histogram({
      name: 'gqlcov_flush_duration_seconds',
      help: 'Batched storage write duration',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [registry],
    }),
    cacheHits: new Counter({
      name: 'gqlcov_document_cache_hits_total',
      help: 'Parsed document cache hits',
      registers: [registry],
    }),
  };
}
