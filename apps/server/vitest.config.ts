import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', 'node', 'import', 'default'] },
  ssr: {
    resolve: {
      conditions: ['source', 'node', 'import', 'default'],
      externalConditions: ['source'],
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000, hookTimeout: 20000 },
});
