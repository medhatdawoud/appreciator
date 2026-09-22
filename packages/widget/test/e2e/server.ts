/**
 * Boots everything the e2e specs need, with nothing faked:
 *
 * - the real MySQL from docker-compose (a dedicated `appreciator_e2e` schema),
 * - the real migrations and the real `create-tenant` CLI,
 * - the real Fastify app serving the API and the built widget bundle,
 * - a plain static server for the example page, on a *different* origin so
 *   the button's origin allowlist and CORS are exercised for real.
 *
 * Playwright starts this as its `webServer` and waits for /healthz.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ButtonColors, CreateButtonResponse } from '@appreciator/shared';

import { buildApp } from '../../../server/src/app.js';
import { runMigrations } from '../../../server/src/db/migrate.js';
import { createPool } from '../../../server/src/db/pool.js';
import { loadAppConfig } from '../../../server/src/env.js';
import {
  API_ORIGIN,
  API_PORT,
  FIXTURE_PATH,
  PAGE_ORIGIN,
  PAGE_PORT,
  type ButtonFixture,
} from './constants.js';

const WIDGET_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ROOT = resolve(WIDGET_DIR, '../..');
const EXAMPLE_DIR = resolve(ROOT, 'examples/plain-html');
const ICON_DIR = resolve(EXAMPLE_DIR, 'appreciator-out');

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'mysql://root:appreciator@127.0.0.1:3306/appreciator_e2e';

const ENV = {
  DATABASE_URL,
  VISITOR_HASH_SECRET: 'e2e-visitor-secret-0123456789abcdef',
  PUBLIC_BASE_URL: API_ORIGIN,
  // The specs click through a whole allowance several times over.
  RATE_LIMIT_MAX: '100000',
  // The allowlist spec deliberately triggers origin rejections, which log at warn.
  LOG_LEVEL: 'error',
  WIDGET_BUNDLE_PATH: resolve(WIDGET_DIR, 'dist/widget.js'),
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const execFileAsync = promisify(execFile);

async function ensureDatabase(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing to create database with unsafe name "${database}"`);
  }
  url.pathname = '/';
  const admin = createPool(url.toString());
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  } finally {
    await admin.end();
  }
}

/** Runs the real CLI and captures the one-time secret it prints. */
async function createTenant(): Promise<string> {
  const { stdout } = await execFileAsync(
    'npm',
    ['run', '--silent', 'create-tenant', '-w', '@appreciator/server', '--', '--name', 'e2e'],
    { cwd: ROOT, env: { ...process.env, ...ENV } },
  );
  const secret = /secret:\s+(\S+)/.exec(stdout)?.[1];
  if (secret === undefined) {
    throw new Error(`create-tenant did not print a secret:\n${stdout}`);
  }
  return secret;
}

async function registerButton(secret: string): Promise<ButtonFixture> {
  const svgSource = await readFile(resolve(ICON_DIR, 'icon.svg'), 'utf8');
  const colors = JSON.parse(await readFile(resolve(ICON_DIR, 'colors.json'), 'utf8')) as ButtonColors;
  const maxClicks = 10;

  const response = await fetch(`${API_ORIGIN}/v1/buttons`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ maxClicks, allowedOrigins: [PAGE_ORIGIN], svgSource, colors }),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/buttons failed: ${response.status} ${await response.text()}`);
  }
  const created = (await response.json()) as CreateButtonResponse;
  return { api: API_ORIGIN, publicKey: created.publicKey, maxClicks, colors };
}

function serveStatic(request: IncomingMessage, response: ServerResponse): void {
  const pathname = new URL(request.url ?? '/', PAGE_ORIGIN).pathname;
  const file = resolve(EXAMPLE_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file.startsWith(EXAMPLE_DIR + sep)) {
    response.writeHead(403).end();
    return;
  }
  readFile(file).then(
    (body) => {
      response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    },
    () => response.writeHead(404).end(),
  );
}

async function main(): Promise<void> {
  await ensureDatabase();

  const config = loadAppConfig({ ...process.env, ...ENV });
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  for (const table of ['visitor_clicks', 'items', 'buttons', 'tenants']) {
    await pool.query(`DELETE FROM \`${table}\``);
  }

  const app = await buildApp({ config, pool });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  const fixture = await registerButton(await createTenant());
  await writeFile(FIXTURE_PATH, JSON.stringify(fixture), 'utf8');

  const pages = createServer(serveStatic);
  await new Promise<void>((done) => pages.listen(PAGE_PORT, '127.0.0.1', done));

  const shutdown = (): void => {
    pages.close();
    void app.close().then(() => pool.end());
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  console.log(`e2e API on ${API_ORIGIN}, example page on ${PAGE_ORIGIN}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
