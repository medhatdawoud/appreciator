import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import type { AccountRow } from '../db/accounts.js';
import { findAccountById } from '../db/accounts.js';
import type { AppConfig } from '../env.js';
import { forbidden, unauthenticated } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountRow | null;
  }
}

export const SESSION_COOKIE = 'appreciator_session';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The header a cookie-authenticated write must carry, and the value it must have. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'appreciator';

/** Methods that must not change state, and so need no CSRF check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type SessionConfig = Pick<AppConfig, 'sessionSecret' | 'publicBaseUrl'>;

function hmac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

/**
 * Signs a JSON payload as `base64url(JSON).base64url(HMAC-SHA256(secret, first part))`.
 *
 * Stateless on purpose: there is no session table to keep in step, and the
 * payload carries nothing secret, only an id and an expiry. The cost is that
 * a session cannot be revoked before it expires except by rotating
 * `SESSION_SECRET`, which signs everyone out.
 */
export function signToken(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(secret, body).toString('base64url')}`;
}

/**
 * Returns the payload of a token `signToken` produced with the same secret,
 * or null for anything else: malformed, tampered with, signed with another
 * secret, or past its `exp` (seconds since the epoch). The signature is
 * compared in constant time and before the payload is parsed, so nothing a
 * client makes up ever reaches `JSON.parse`.
 */
export function verifyToken(
  secret: string,
  token: string | undefined,
): Record<string, unknown> | null {
  if (token === undefined) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = hmac(secret, body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const { exp } = payload as { exp?: unknown };
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;

  return payload as Record<string, unknown>;
}

/** Seconds since the epoch, `ttlSeconds` from now. */
export function expiresIn(ttlSeconds: number): number {
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

/**
 * Builds a Set-Cookie value with the attributes every cookie this server sets
 * shares. `HttpOnly` keeps them away from page script; `SameSite=Lax` keeps
 * them off cross-site subrequests while still sending them on the top-level
 * redirect back from GitHub; `Secure` whenever the deployment is served over
 * https.
 *
 * Built by hand rather than with @fastify/cookie's static `serialize`, which
 * only works once the plugin has been registered on an instance. The values
 * are always base64url tokens or empty, so there is nothing to encode.
 */
export function serializeCookie(
  config: Pick<AppConfig, 'publicBaseUrl'>,
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const attributes = [
    `${name}=${value}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (config.publicBaseUrl.startsWith('https://')) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** The Set-Cookie value that signs `accountId` in for seven days. */
export function createSessionCookie(config: SessionConfig, accountId: string): string {
  if (config.sessionSecret === undefined) {
    throw new Error('createSessionCookie needs SESSION_SECRET');
  }
  const token = signToken(config.sessionSecret, {
    accountId,
    exp: expiresIn(SESSION_TTL_SECONDS),
  });
  return serializeCookie(config, SESSION_COOKIE, token, SESSION_TTL_SECONDS);
}

/** The Set-Cookie value that removes the session cookie. */
export function clearSessionCookie(config: Pick<AppConfig, 'publicBaseUrl'>): string {
  return serializeCookie(config, SESSION_COOKIE, '', 0);
}

/** Reads a session cookie's value. Null means signed out, whatever the reason. */
export function readSession(
  config: SessionConfig,
  cookieValue: string | undefined,
): { accountId: string } | null {
  if (config.sessionSecret === undefined) return null;

  const payload = verifyToken(config.sessionSecret, cookieValue);
  if (payload === null || typeof payload.accountId !== 'string') return null;
  return { accountId: payload.accountId };
}

/**
 * onRequest hook for cookie-authenticated routes: resolves the signed-in
 * account onto `request.account`, or answers 401. A valid session for an
 * account that has since been deleted is treated as signed out rather than as
 * an error.
 */
export async function requireSession(request: FastifyRequest): Promise<void> {
  const session = readSession(request.server.appConfig, request.cookies[SESSION_COOKIE]);
  if (session === null) {
    throw unauthenticated();
  }

  const account = await findAccountById(request.server.pool, session.accountId);
  if (account === undefined) {
    throw unauthenticated();
  }
  request.account = account;
}

/** Narrows `request.account` for handlers, which only run behind `requireSession`. */
export function accountOf(request: FastifyRequest): AccountRow {
  if (request.account === null) {
    throw unauthenticated();
  }
  return request.account;
}

function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether a cookie-authenticated request may proceed, as far as CSRF goes.
 *
 * Reads are always fine. A write needs both a custom header, which a
 * cross-site form or a simple cross-site fetch cannot send, and an `Origin`
 * (or, when a browser omits that, a `Referer`) from the dashboard's own
 * origin. Either check alone would do today; both means one browser quirk is
 * not enough to open the hole.
 */
export function isCsrfSafe(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  expectedOrigin: string,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;

  if (headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) return false;

  const origin = headers.origin;
  const referer = headers.referer;
  const source =
    typeof origin === 'string'
      ? originOf(origin)
      : typeof referer === 'string'
        ? originOf(referer)
        : undefined;
  return source !== undefined && source === expectedOrigin;
}

/** onRequest hook enforcing `isCsrfSafe` against the origin of `PUBLIC_BASE_URL`. */
export async function requireCsrf(request: FastifyRequest): Promise<void> {
  const expectedOrigin = new URL(request.server.appConfig.publicBaseUrl).origin;
  if (!isCsrfSafe(request.method, request.headers, expectedOrigin)) {
    throw forbidden('Cross-site request refused', 'csrf');
  }
}
