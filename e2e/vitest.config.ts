import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: { include: ['e2e/**/*.e2e.test.ts'], testTimeout: 60000, hookTimeout: 60000 },
});
