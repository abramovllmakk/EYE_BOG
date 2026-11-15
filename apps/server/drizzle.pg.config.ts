import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/storage/schema.pg.ts',
  out: './drizzle/pg',
});
