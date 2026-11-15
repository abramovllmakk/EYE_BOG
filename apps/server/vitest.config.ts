import { defineConfig } from 'vitest/config';

// `source` resolves workspace packages to their TypeScript sources (no build needed for tests).
// Only `source` is added: Vitest forwards conditions to Node, and an extra `import` condition would
// make CommonJS `require()` (e.g. pg → pg-pool) receive ESM namespaces.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000, hookTimeout: 20000 },
});
