import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Account } from '@appreciator/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { toAccount, upsertAccount } from '../db/accounts.js';
import { HttpError, notFound } from '../lib/errors.js';
import { buildAuthorizeUrl, exchangeCode, fetchUser, isLoginAllowed } from '../lib/github.js';
import { registerIpRateLimit } from '../lib/rate-limit.js';
import {
  SESSION_COOKIE,
  accountOf,
  clearSessionCookie,
  createSessionCookie,
  expiresIn,
  requireCsrf,
  requireSession,
  serializeCookie,
  signToken,
  verifyToken,
} from '../lib/session.js';

export const OAUTH_STATE_COOKIE = 'appreciator_oauth_state';

/** Long enough to read GitHub's consent screen, short enough that a stale tab cannot finish. */
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

const accountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'login', 'avatarUrl'],
  properties: {
    id: { type: 'string' },
    login: { type: 'string' },
    avatarUrl: { type: ['string', 'null'] },
  },
};

function signInDisabled(): HttpError {
  return notFound('Sign-in is not enabled on this server', 'sign_in_disabled');
}

function invalidState(): HttpError {
  return new HttpError(400, 'invalid_state', 'Sign-in link expired or was not started here');
}

function sessionSecretOf(request: FastifyRequest): string {
  const { signInEnabled, sessionSecret } = request.server.appConfig;
  if (!signInEnabled || sessionSecret === undefined) {
    throw signInDisabled();
  }
  return sessionSecret;
}

/**
 * Whether the `state` GitHub echoed back is the one this browser was sent
 * off with. The expected value lives only in a signed, short-lived cookie,
 * so a callback URL crafted elsewhere - login CSRF - does not match.
 */
function stateMatches(secret: string, cookie: string | undefined, state: string | undefined) {
  const payload = verifyToken(secret, cookie);
  if (payload === null || typeof payload.state !== 'string' || state === undefined) {
    return false;
  }
  const expected = Buffer.from(payload.state, 'utf8');
  const given = Buffer.from(state, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Sends the browser to the landing page with a reason it can show. */
function redirectWithError(reply: FastifyReply, error: string): FastifyReply {
  return reply.redirect(`/?error=${error}`, 302);
}

/**
 * "Sign in with GitHub". There is no signup: only the logins listed in
 * `GITHUB_ALLOWED_LOGINS` get an account, and everyone else is turned away
 * after GitHub tells us who they are.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Own scope and store, like the public routes, and ahead of the session
  // and CSRF hooks: the callback makes outbound requests to GitHub and
  // /auth/me reads the database, so neither may be unmetered.
  await registerIpRateLimit(app, app.appConfig.rateLimitMax);

  app.get('/auth/github', async (request, reply) => {
    const secret = sessionSecretOf(request);

    const state = randomBytes(32).toString('base64url');
    const cookie = signToken(secret, { state, exp: expiresIn(OAUTH_STATE_TTL_SECONDS) });

    return reply
      .header(
        'set-cookie',
        serializeCookie(app.appConfig, OAUTH_STATE_COOKIE, cookie, OAUTH_STATE_TTL_SECONDS),
      )
      .redirect(buildAuthorizeUrl(app.appConfig, state), 302);
  });

  app.get<{ Querystring: CallbackQuery }>(
    '/auth/github/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          // GitHub may add parameters (error_description, error_uri); they
          // are ignored rather than refused.
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 512 },
            state: { type: 'string', minLength: 1, maxLength: 512 },
            error: { type: 'string', maxLength: 255 },
          },
        },
      },
    },
    async (request, reply) => {
      const secret = sessionSecretOf(request);
      // The state is single-use whatever happens next.
      void reply.header('set-cookie', serializeCookie(app.appConfig, OAUTH_STATE_COOKIE, '', 0));

      const { code, state, error } = request.query;
      if (!stateMatches(secret, request.cookies[OAUTH_STATE_COOKIE], state)) {
        request.log.warn({ ip: request.ip }, 'oauth callback with invalid state');
        throw invalidState();
      }

      if (error !== undefined || code === undefined) {
        // Typically the user pressing "Cancel" on GitHub's consent screen.
        request.log.info({ error }, 'oauth callback without a code');
        return redirectWithError(reply, 'sign_in_failed');
      }

      let user;
      try {
        const token = await exchangeCode(app.appConfig, code);
        user = await fetchUser(app.appConfig, token);
      } catch (cause) {
        request.log.error({ err: cause }, 'github sign-in failed');
        return redirectWithError(reply, 'sign_in_failed');
      }

      if (!isLoginAllowed(user.login, app.appConfig.githubAllowedLogins)) {
        request.log.warn(
          { login: user.login, githubId: user.id, ip: request.ip },
          'sign-in refused: login is not on GITHUB_ALLOWED_LOGINS',
        );
        return redirectWithError(reply, 'not_allowed');
      }

      const account = await upsertAccount(app.pool, {
        githubId: user.id,
        login: user.login,
        avatarUrl: user.avatar_url,
      });
      request.log.info({ accountId: account.id, login: account.login }, 'signed in');

      return reply
        .header('set-cookie', [
          serializeCookie(app.appConfig, OAUTH_STATE_COOKIE, '', 0),
          createSessionCookie(app.appConfig, account.id),
        ])
        .redirect('/dashboard', 302);
    },
  );

  app.post(
    '/auth/logout',
    { onRequest: requireCsrf, schema: { response: { 204: { type: 'null' } } } },
    async (request, reply) => {
      if (request.cookies[SESSION_COOKIE] !== undefined) {
        request.log.info('signed out');
      }
      return reply.header('set-cookie', clearSessionCookie(app.appConfig)).status(204).send();
    },
  );

  app.get(
    '/auth/me',
    { onRequest: requireSession, schema: { response: { 200: accountSchema } } },
    async (request): Promise<Account> => toAccount(accountOf(request)),
  );
}
