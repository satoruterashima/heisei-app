import app from './index.js';

// Staging/production templates use this entrypoint so the configured Durable
// Object class is exported without making the regular Hono unit-test entrypoint
// depend on the Cloudflare-only module.
export { QuotaActor } from './quota-do-worker.js';
export default app;
