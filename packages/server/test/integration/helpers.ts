import mysql from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from '../../src/db/pool.js';
import { createPool, execute } from '../../src/db/pool.js';
import type { AppConfig } from '../../src/env.js';
import { generateSecretKey, hashSecretKey } from '../../src/lib/auth.js';

/**
 * These tests run against the MySQL in the repo's docker-compose, with no
 * doubles of any kind: real driver, real transactions, real locking. The
 * concurrency guarantee we care about only exists at that layer, so a mocked
 * database would test nothing.
 *
 * Defaults to the root account because the test schema has to be created, and
 * the compose file only grants the `appreciator` user its own database.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'mysql://root:appreciator@127.0.0.1:3306/appreciator_test';

export const TEST_VISITOR_SECRET = 'integration-test-secret-0123456789ab';

/** Tables in dependency order; used to reset state between tests. */
const TABLES = ['visitor_clicks', 'items', 'buttons', 'tenants'];

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: TEST_DATABASE_URL,
    visitorHashSecret: TEST_VISITOR_SECRET,
    managementSecret: undefined,
    defaultMaxClicks: 10,
    publicBaseUrl: 'https://appreciator.test',
    // Effectively disabled by default so unrelated tests are not throttled.
    // The rate limit has its own test that sets a real value.
    rateLimitMax: 100_000,
    rateLimitWindow: '1 minute',
    trustProxy: false,
    logLevel: 'silent',
    // Points at nothing by default, so /widget.js answers its missing-bundle
    // 404 unless a test supplies a fixture. The widget package is not a
    // dependency of these tests.
    widgetBundlePath: '/nonexistent/appreciator-widget-bundle.js',
    ...overrides,
  };
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  // A database name is an identifier, so it cannot be a bound parameter. It is
  // whitelisted here instead; this is test-only code and the value comes from
  // the developer's own environment, not from a request.
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing to create database with unsafe name "${database}"`);
  }

  parsed.pathname = '/';
  const connection = await mysql.createConnection(parsed.toString());
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  } finally {
    await connection.end();
  }
}

let schemaReady: Promise<void> | undefined;

/** Creates the test schema and applies migrations once per process. */
export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureDatabaseExists(TEST_DATABASE_URL);
    const pool = createPool(TEST_DATABASE_URL);
    try {
      await runMigrations(pool);
    } finally {
      await pool.end();
    }
  })();
  return schemaReady;
}

/** Empties every table. Foreign key checks are toggled on one pinned connection. */
export async function truncateAll(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      await connection.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    connection.release();
  }
}

export interface TestContext {
  app: FastifyInstance;
  pool: Pool;
  config: AppConfig;
}

/** Boots a migrated, empty database and an app wired to it. */
export async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  await ensureSchema();
  const config = testConfig(overrides);
  const pool = createPool(config.databaseUrl);
  await truncateAll(pool);
  const app = await buildApp({ config, pool });
  await app.ready();
  return { app, pool, config };
}

export async function closeTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.pool.end();
}

export interface TestTenant {
  id: string;
  name: string;
  secret: string;
  authHeader: string;
}

/** Inserts a tenant directly, the same way the create-tenant CLI does. */
export async function seedTenant(pool: Pool, name = 'Test Tenant'): Promise<TestTenant> {
  const id = crypto.randomUUID();
  const secret = generateSecretKey();
  await execute(pool, 'INSERT INTO tenants (id, name, secret_key_hash) VALUES (?, ?, ?)', [
    id,
    name,
    hashSecretKey(secret),
  ]);
  return { id, name, secret, authHeader: `Bearer ${secret}` };
}
