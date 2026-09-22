import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Pool } from './pool.js';
import { createPool, execute, queryRows } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Migration files are `NNN_name.sql` and hold exactly one statement each. The
 * pool runs with `multipleStatements: false`, so a file that smuggles in a
 * second statement fails loudly rather than executing.
 */
const MIGRATION_FILE_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/;

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    name VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((entry) => entry.endsWith('.sql'));

  for (const file of files) {
    if (!MIGRATION_FILE_PATTERN.test(file)) {
      throw new Error(`Migration file "${file}" does not match NNN_name.sql`);
    }
  }

  return files.sort();
}

/** Applies every migration that is not yet recorded in `_migrations`, in name order. */
export async function runMigrations(
  pool: Pool,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  await pool.query(CREATE_MIGRATIONS_TABLE);

  const appliedRows = await queryRows<{ name: string }>(pool, 'SELECT name FROM _migrations');
  const applied = new Set(appliedRows.map((row) => row.name));

  const pending = (await listMigrationFiles()).filter((file) => !applied.has(file));
  if (pending.length === 0) {
    log('No pending migrations.');
    return [];
  }

  for (const file of pending) {
    const sql = (await readFile(join(MIGRATIONS_DIR, file), 'utf8')).trim().replace(/;$/, '');
    log(`Applying ${file}...`);
    // DDL cannot be a prepared statement, so it goes through `query`. The SQL
    // comes from files on disk that ship with the package, never from input.
    await pool.query(sql);
    await execute(pool, 'INSERT INTO _migrations (name) VALUES (?)', [file]);
  }

  log(`Applied ${pending.length} migration(s).`);
  return pending;
}

async function main(): Promise<void> {
  const { loadAppConfig } = await import('../env.js');
  const config = loadAppConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await runMigrations(pool, (message) => console.log(message));
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Migration failed');
    process.exitCode = 1;
  });
}
