import { randomUUID } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import { execute } from '../db/pool.js';
import { findTenantBySecretKey, hashSecretKey } from './auth.js';

/** Name given to the tenant that `MANAGEMENT_SECRET` provisions. */
export const MANAGEMENT_TENANT_NAME = 'default';

export interface BootstrapResult {
  tenantId: string;
  created: boolean;
}

/** MySQL's duplicate-key error, raised when two starts race to insert the same hash. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * Makes sure a tenant exists whose management secret is `secret`.
 *
 * This is how a deployment gets its first (and usually only) management key
 * without running the `create-tenant` CLI: the operator sets
 * `MANAGEMENT_SECRET` once, in the same place as the other secrets, and every
 * start converges on the same tenant. Only the hash is stored, so rotating the
 * variable creates a new tenant rather than re-keying the old one; the old
 * tenant and its buttons stay put under the old (now unknown) secret.
 *
 * Idempotent and safe under concurrent starts: a lost race on the unique hash
 * index is resolved by reading the winner back.
 */
export async function ensureManagementTenant(pool: Pool, secret: string): Promise<BootstrapResult> {
  const existing = await findTenantBySecretKey(pool, secret);
  if (existing !== undefined) {
    return { tenantId: existing.id, created: false };
  }

  const id = randomUUID();
  try {
    await execute(pool, 'INSERT INTO tenants (id, name, secret_key_hash) VALUES (?, ?, ?)', [
      id,
      MANAGEMENT_TENANT_NAME,
      hashSecretKey(secret),
    ]);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = await findTenantBySecretKey(pool, secret);
    if (winner === undefined) throw error;
    return { tenantId: winner.id, created: false };
  }

  return { tenantId: id, created: true };
}
