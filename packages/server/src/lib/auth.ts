import { createHash, randomBytes } from 'node:crypto';

import type { Executor } from '../db/pool.js';
import { queryOne } from '../db/pool.js';

/** Prefix on management secrets, so a leaked token is recognisable in logs and scanners. */
export const SECRET_KEY_PREFIX = 'apr_sk_';

/** Prefix on public keys, which are embedded in page source and are not secret. */
export const PUBLIC_KEY_PREFIX = 'pk_';

/**
 * Upper bound on a bearer token we are willing to hash. Real keys are ~50
 * characters; this stops a client from making us digest a multi-megabyte header.
 */
const MAX_BEARER_LENGTH = 256;

/** Mints a management secret. 256 bits from the CSPRNG. */
export function generateSecretKey(): string {
  return `${SECRET_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Mints a button's public key. 128 bits: not secret, but not enumerable either. */
export function generatePublicKey(): string {
  return `${PUBLIC_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
}

/**
 * Hashes a management secret for storage and lookup.
 *
 * SHA-256 rather than bcrypt/argon2 on purpose. Those exist to slow down
 * guessing of *low-entropy, human-chosen* passwords. A management key is 256
 * random bits, so there is no guessing attack for a slow KDF to frustrate, and
 * a plain digest lets us find the tenant with one indexed lookup instead of
 * loading every tenant row and running a slow comparison against each.
 *
 * The consequence to respect: the stored value is only as unguessable as the
 * key, so keys must always come from `generateSecretKey`, never from a human.
 */
export function hashSecretKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Pulls the token out of an `Authorization: Bearer <token>` header.
 *
 * Returns undefined for anything malformed rather than throwing, so callers
 * answer with the same generic 401 whatever the shape of the failure.
 */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;

  const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];
  if (token === undefined || token.length > MAX_BEARER_LENGTH) return undefined;

  return token;
}

export interface TenantRow {
  id: string;
  name: string;
}

/**
 * Resolves the tenant a management secret belongs to.
 *
 * The comparison happens as an indexed lookup on the digest, so the plaintext
 * secret is never compared byte-by-byte and never read back out of the database.
 */
export async function findTenantBySecretKey(
  executor: Executor,
  secret: string,
): Promise<TenantRow | undefined> {
  return queryOne<TenantRow>(executor, 'SELECT id, name FROM tenants WHERE secret_key_hash = ?', [
    hashSecretKey(secret),
  ]);
}

/** Canonicalises an origin so `https://a.com/` and `https://A.com` compare equal. */
function canonicalOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    // Not a parseable URL: could be the literal "null" origin a sandboxed
    // iframe sends. Compare it verbatim so it only matches an explicit entry.
    return value.trim();
  }
}

/**
 * Checks a request's `Origin` against a button's allowlist.
 *
 * `*` in the allowlist opts a button out of the check entirely. That is a real
 * loosening — it lets any site render the button and spend its counters — so it
 * is only ever there because a tenant asked for it.
 *
 * Note this is a defence against *casual* embedding, not an authorization
 * boundary: `Origin` is set by the browser, and a non-browser client can send
 * whatever it likes. Per-IP rate limiting is what bounds abuse.
 */
export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes('*')) return true;

  const candidate = canonicalOrigin(origin);
  return allowedOrigins.some((allowed) => canonicalOrigin(allowed) === candidate);
}
