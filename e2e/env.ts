/** Targets a running stack: `docker compose up -d` (defaults) or any deployed instance. */
export const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:4001';
export const PROXY_URL = process.env.E2E_PROXY_URL ?? 'http://localhost:4000/graphql';
