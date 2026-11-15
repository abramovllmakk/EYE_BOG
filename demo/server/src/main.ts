import { startDemoServer } from './app.js';

const port = Number(process.env.PORT ?? 4100);
const server = await startDemoServer(port, {
  disableIntrospection: process.env.DISABLE_INTROSPECTION === 'true',
});
console.log(`demo GraphQL API listening on http://localhost:${port}/graphql`);
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
