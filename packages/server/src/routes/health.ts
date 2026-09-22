import type { FastifyInstance } from 'fastify';

import { queryRows } from '../db/pool.js';

const healthSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string' } },
    },
    503: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string' } },
    },
  },
} as const;

/**
 * Liveness plus a database round-trip, so an instance that cannot reach MySQL
 * is taken out of rotation rather than serving errors.
 *
 * The response body is a fixed string either way: why the database is
 * unreachable goes to the log, not to an unauthenticated caller.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', { schema: healthSchema }, async (request, reply) => {
    try {
      await queryRows(app.pool, 'SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      request.log.error({ err: error }, 'health check failed to reach the database');
      return reply.status(503).send({ status: 'degraded' });
    }
  });
}
