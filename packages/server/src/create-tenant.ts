import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createPool, execute } from './db/pool.js';
import { loadAppConfig } from './env.js';
import { generateSecretKey, hashSecretKey } from './lib/auth.js';

/**
 * Creates a tenant and prints its management secret exactly once.
 *
 * Without this there is no way to obtain a management key, since only the hash
 * of a secret is ever stored and there is no self-serve signup endpoint. The
 * plaintext is written to stdout and then dropped: it cannot be recovered, and
 * a lost key means creating a new tenant.
 *
 *   npm run create-tenant -w @appreciator/server -- --name "Some Name"
 */
const MAX_NAME_LENGTH = 255;

function parseName(argv: string[]): string {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: 'string', short: 'n' } },
    allowPositionals: false,
  });

  const name = values.name?.trim();
  if (name === undefined || name.length === 0) {
    throw new Error('Usage: npm run create-tenant -- --name "Tenant Name"');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`--name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

async function main(): Promise<void> {
  const name = parseName(process.argv.slice(2));
  const config = loadAppConfig();
  const pool = createPool(config.databaseUrl);

  try {
    const id = randomUUID();
    const secret = generateSecretKey();

    await execute(pool, 'INSERT INTO tenants (id, name, secret_key_hash) VALUES (?, ?, ?)', [
      id,
      name,
      hashSecretKey(secret),
    ]);

    console.log(`Tenant created.\n`);
    console.log(`  id:     ${id}`);
    console.log(`  name:   ${name}`);
    console.log(`  secret: ${secret}\n`);
    console.log('Store the secret now - only its hash is kept, so it cannot be shown again.');
    console.log('Use it as: Authorization: Bearer <secret>');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Failed to create tenant');
  process.exitCode = 1;
});
