import { randomUUID } from 'node:crypto';

import { insertButton } from '../db/buttons.js';
import type { Pool } from '../db/pool.js';
import { execute, queryOne } from '../db/pool.js';
import type { AppConfig } from '../env.js';
import { findTenantBySecretKey, generateSecretKey, hashSecretKey } from './auth.js';
import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from './default-icon.js';

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

/** Name of the tenant that owns the landing page's demo button. */
export const DEMO_TENANT_NAME = 'demo';

/** Name of the demo button inside that tenant. */
export const DEMO_BUTTON_NAME = 'Landing demo';

/** MySQL named lock that serialises concurrent demo bootstraps. */
const DEMO_LOCK_NAME = 'appreciator_demo_bootstrap';
const DEMO_LOCK_TIMEOUT_SECONDS = 10;

export interface DemoButtonResult {
  tenantId: string;
  buttonId: string;
  publicKey: string;
  created: boolean;
}

/**
 * Makes sure the landing page's demo button exists: a tenant named `demo`
 * with no owning account, holding one button named `Landing demo` with the
 * default heart and `DEMO_ALLOWED_ORIGINS` as its allowlist.
 *
 * The tenant gets a random management secret that is hashed and dropped, so
 * nobody can manage the demo through the API; it only changes here. On every
 * start the allowlist is brought in line with the environment, and nothing
 * else about an existing button is touched.
 *
 * Neither the tenant name nor the button name is unique in the schema, so
 * concurrent starts are serialised with a MySQL named lock rather than
 * resolved on a duplicate-key error as `ensureManagementTenant` does.
 */
export async function ensureDemoButton(
  pool: Pool,
  config: Pick<AppConfig, 'demoAllowedOrigins' | 'defaultMaxClicks'>,
): Promise<DemoButtonResult> {
  const connection = await pool.getConnection();
  try {
    // Named locks belong to the session, so everything below has to run on
    // this one connection.
    const lock = await queryOne<{ acquired: number | null }>(
      connection,
      'SELECT GET_LOCK(?, ?) AS acquired',
      [DEMO_LOCK_NAME, DEMO_LOCK_TIMEOUT_SECONDS],
    );
    if (lock?.acquired !== 1) {
      throw new Error('timed out waiting for another process to provision the demo button');
    }

    try {
      let created = false;
      let tenant = await queryOne<{ id: string }>(
        connection,
        `SELECT id FROM tenants WHERE name = ? AND account_id IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1`,
        [DEMO_TENANT_NAME],
      );
      if (tenant === undefined) {
        tenant = { id: randomUUID() };
        await execute(
          connection,
          'INSERT INTO tenants (id, name, secret_key_hash) VALUES (?, ?, ?)',
          [tenant.id, DEMO_TENANT_NAME, hashSecretKey(generateSecretKey())],
        );
      }

      let button = await queryOne<{ id: string; public_key: string }>(
        connection,
        `SELECT id, public_key FROM buttons WHERE tenant_id = ? AND name = ?
          ORDER BY created_at ASC, id ASC LIMIT 1`,
        [tenant.id, DEMO_BUTTON_NAME],
      );
      if (button === undefined) {
        const inserted = await insertButton(connection, {
          tenantId: tenant.id,
          name: DEMO_BUTTON_NAME,
          maxClicks: config.defaultMaxClicks,
          allowedOrigins: config.demoAllowedOrigins,
          svgSource: DEFAULT_SVG_SOURCE,
          colors: DEFAULT_COLORS,
          svgSources: null,
          urlNormalization: 'pathname',
        });
        button = { id: inserted.id, public_key: inserted.publicKey };
        created = true;
      } else {
        await execute(connection, 'UPDATE buttons SET allowed_origins = ? WHERE id = ?', [
          JSON.stringify(config.demoAllowedOrigins),
          button.id,
        ]);
      }

      return { tenantId: tenant.id, buttonId: button.id, publicKey: button.public_key, created };
    } finally {
      await queryOne(connection, 'SELECT RELEASE_LOCK(?) AS released', [DEMO_LOCK_NAME]);
    }
  } finally {
    connection.release();
  }
}
