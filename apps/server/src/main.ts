#!/usr/bin/env node
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

let loaded;
try {
  loaded = loadConfig(process.argv[2]);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}
const app = createApp(loaded.config, loaded.baseDir);
await app.init();
const { proxyUrl, adminUrl } = await app.listen();
app.log.info(
  { proxy: `${proxyUrl}/graphql`, ui: adminUrl, docs: `${adminUrl}/docs` },
  'gqlcov ready',
);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down (flushing analysis queue)');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
