import { randomUUID } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { Pool } from './db/pool.js';
import type { AppConfig } from './env.js';
import { HttpError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { managementRoutes } from './routes/management.js';
import { publicRoutes } from './routes/public.js';
import { siteRoutes } from './routes/sites.js';
import { webRoutes } from './routes/web.js';
import { widgetRoutes } from './routes/widget.js';

/**
 * Request body ceiling. The only large fields we accept are the icons: one
 * `svgSource`, or four `svgSources`, each capped at 64 KiB by `assertSafeSvg`.
 * Four maximum-size icons are 256 KiB before JSON escaping, so this leaves
 * room for the escaping while still refusing a multi-megabyte POST before it
 * is parsed.
 */
const BODY_LIMIT_BYTES = 512 * 1024;

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    appConfig: AppConfig;
    /** Public key of the landing page's demo button, or null when there is none. */
    demoPublicKey: string | null;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  pool: Pool;
  /** From `ensureDemoButton`, which runs before the app is built. */
  demoPublicKey?: string | null;
}

export async function buildApp({
  config,
  pool,
  demoPublicKey = null,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => randomUUID(),
    bodyLimit: BODY_LIMIT_BYTES,
    // Only honour X-Forwarded-For when we are actually behind a proxy we
    // control. Trusting it unconditionally would let any client spoof its
    // source address and walk around the per-IP rate limit.
    trustProxy: config.trustProxy,
    ajv: {
      customOptions: {
        // Fastify defaults this to true, which silently *drops* properties that
        // `additionalProperties: false` disallows. We want the request refused
        // instead: a client sending a field we do not understand is a client
        // whose intent we cannot honour, and quietly ignoring it is how a typo
        // in a config key becomes a button that does not do what its owner
        // believes it does.
        removeAdditional: false,
      },
    },
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
        censor: '[redacted]',
      },
    },
  });

  app.decorate('pool', pool);
  app.decorate('appConfig', config);
  app.decorate('demoPublicKey', demoPublicKey);
  // Cookies are parsed for every route, but only the session routes read
  // them; the bearer and public-key routes ignore them entirely.
  await app.register(fastifyCookie);
  app.decorateRequest('account', null);

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      statusCode: 404,
      error: 'not_found',
      message: 'Not found',
      requestId: request.id,
    });
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    // Schema validation failures describe the caller's own request, so the
    // detail is useful to them and reveals nothing about the server.
    if (error.validation) {
      request.log.info({ err: error }, 'request failed validation');
      return reply.status(400).send({
        statusCode: 400,
        error: 'bad_request',
        message: error.message,
        requestId: request.id,
      });
    }

    if (error instanceof HttpError) {
      // Auth and authorization failures are the events worth reviewing later,
      // so they are logged at warn with the route and source address.
      const level = error.statusCode === 401 || error.statusCode === 403 ? 'warn' : 'info';
      request.log[level](
        { code: error.code, statusCode: error.statusCode, ip: request.ip },
        error.message,
      );
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.code,
        message: error.message,
        requestId: request.id,
      });
    }

    // Errors raised by plugins (rate limiting, body limit, malformed JSON)
    // carry their own status and a message written for clients.
    const pluginStatus = error.statusCode;
    if (typeof pluginStatus === 'number' && pluginStatus >= 400 && pluginStatus < 500) {
      request.log.info({ err: error, ip: request.ip }, 'request rejected');
      return reply.status(pluginStatus).send({
        statusCode: pluginStatus,
        // The rate limiter raises a 429 with no code of its own.
        error: error.code ?? (pluginStatus === 429 ? 'rate_limited' : 'bad_request'),
        message: error.message,
        requestId: request.id,
      });
    }

    // Anything else is ours. Log it in full, tell the client nothing but the
    // request id they can quote when reporting the failure.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      statusCode: 500,
      error: 'internal_error',
      message: 'Internal server error',
      requestId: request.id,
    });
  });

  await app.register(healthRoutes);

  // Each route group is its own plugin scope, so the management bearer-auth
  // hook cannot leak onto the public routes and the public CORS and rate-limit
  // hooks cannot leak onto the management ones.
  await app.register(managementRoutes);
  await app.register(publicRoutes);
  // Outside the public button scope: it takes no public key, so it has no
  // button allowlist to check, and a plain <script src> needs no CORS.
  await app.register(widgetRoutes);
  // Cookie-authenticated dashboard sign-in, with its own rate limit.
  await app.register(authRoutes);
  // The dashboard's sites: session cookie plus CSRF, never the bearer secret.
  await app.register(siteRoutes);
  await app.register(webRoutes);
  await app.register(leaderboardRoutes);

  return app;
}
