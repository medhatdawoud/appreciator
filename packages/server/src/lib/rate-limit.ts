import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

/**
 * Puts a per-IP rate limit on every route in the calling plugin scope, as the
 * scope's first onRequest hook.
 *
 * Left to itself, @fastify/rate-limit appends its hook to each route's own
 * hook list, and a scope's `addHook` hooks run before those. Any request that
 * a scope-level hook rejects - an unknown public key, a disallowed origin, a
 * missing session - would then never be counted, so a client could send
 * unlimited rejected requests, each costing a database lookup. Registering
 * with `global: false` and installing the hook explicitly makes the limit run
 * first, before any other hook in the scope does work.
 *
 * Call it before adding any other onRequest hook or plugin that adds one.
 * Each scope keeps its own in-memory store, so sibling scopes have separate
 * budgets. That store is per process: a deployment running several instances
 * behind a load balancer needs a shared store to make the limit a hard one.
 */
export async function registerIpRateLimit(app: FastifyInstance, max: number): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: false,
    max,
    timeWindow: app.appConfig.rateLimitWindow,
    keyGenerator: (request) => request.ip,
  });
  app.addHook('onRequest', app.rateLimit());
}
