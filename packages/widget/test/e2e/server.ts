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
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  ButtonColors,
  ButtonConfigInput,
  ButtonSvgSources,
  CreateButtonResponse,
} from '@appreciator/shared';

import { buildApp } from '../../../server/src/app.js';
import { runMigrations } from '../../../server/src/db/migrate.js';
import { createPool, execute, type Pool } from '../../../server/src/db/pool.js';
import { loadAppConfig, type AppConfig } from '../../../server/src/env.js';
import { ensureDemoButton } from '../../../server/src/lib/bootstrap.js';
import { createSessionCookie } from '../../../server/src/lib/session.js';
import {
  API_ORIGIN,
  API_PORT,
  FIXTURE_PATH,
  PAGE_ORIGIN,
  PAGE_PORT,
  type E2eFixture,
  type SessionFixture,
} from './constants.js';

const WIDGET_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ROOT = resolve(WIDGET_DIR, '../..');
const EXAMPLE_DIR = resolve(ROOT, 'examples/plain-html');
const ICON_DIR = resolve(EXAMPLE_DIR, 'appreciator-out');
const EXPLICIT_ICON_DIR = resolve(EXAMPLE_DIR, 'appreciator-out-explicit');

const TENANT_NAME = 'e2e';
const ACCOUNT_LOGIN = 'e2e';

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
  // The landing page's demo button, clickable from the page itself and from
  // the example page's origin.
  DEMO_BUTTON: 'true',
  DEMO_ALLOWED_ORIGINS: `${API_ORIGIN},${PAGE_ORIGIN}`,
  LEADERBOARD: 'true',
  // Sign-in is configured so the pages offer it, but the GitHub hop is never
  // taken: the dashboard spec signs in with a cookie minted below.
  GITHUB_CLIENT_ID: 'e2e-client-id',
  GITHUB_CLIENT_SECRET: 'e2e-client-secret',
  GITHUB_ALLOWED_LOGINS: ACCOUNT_LOGIN,
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
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
    ['run', '--silent', 'create-tenant', '-w', '@appreciator/server', '--', '--name', TENANT_NAME],
    { cwd: ROOT, env: { ...process.env, ...ENV } },
  );
  const secret = /secret:\s+(\S+)/.exec(stdout)?.[1];
  if (secret === undefined) {
    throw new Error(`create-tenant did not print a secret:\n${stdout}`);
  }
  return secret;
}

async function createButton(secret: string, input: ButtonConfigInput): Promise<string> {
  const response = await fetch(`${API_ORIGIN}/v1/buttons`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/buttons failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as CreateButtonResponse).publicKey;
}

/**
 * An SVG as someone would upload it straight from a design tool: a hard-coded
 * fill and none of the colour variables svg-gen would add.
 */
const RAW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path fill="#000000" d="M12 2 22 21H2z"/></svg>';

/**
 * One button with the example's recolourable icon, one with its four explicit
 * star drawings, and three with a raw uploaded SVG: painted with the button's
 * colours, keeping its own, and painted with a ring around it.
 */
async function registerButtons(
  secret: string,
): Promise<Omit<E2eFixture, 'siteName' | 'demoKey' | 'session'>> {
  const svgSource = await readFile(resolve(ICON_DIR, 'icon.svg'), 'utf8');
  const colors = JSON.parse(
    await readFile(resolve(ICON_DIR, 'colors.json'), 'utf8'),
  ) as ButtonColors;
  const { svgSources } = JSON.parse(
    await readFile(resolve(EXPLICIT_ICON_DIR, 'svgSources.json'), 'utf8'),
  ) as { svgSources: ButtonSvgSources };
  const maxClicks = 10;
  const allowedOrigins = [PAGE_ORIGIN];

  return {
    api: API_ORIGIN,
    publicKey: await createButton(secret, { maxClicks, allowedOrigins, svgSource, colors }),
    explicitKey: await createButton(secret, {
      name: 'Explicit stars',
      maxClicks,
      allowedOrigins,
      svgSources,
    }),
    rawKey: await createButton(secret, {
      name: 'Raw SVG',
      maxClicks,
      allowedOrigins,
      svgSource: RAW_SVG,
      colors,
    }),
    ownKey: await createButton(secret, {
      name: 'Raw SVG, own colours',
      maxClicks,
      allowedOrigins,
      svgSource: RAW_SVG,
      colors,
      keepIconColors: true,
    }),
    ringKey: await createButton(secret, {
      name: 'Raw SVG, ringed',
      maxClicks,
      allowedOrigins,
      svgSource: RAW_SVG,
      colors,
      iconRing: true,
    }),
    maxClicks,
    colors,
  };
}

/**
 * Inserts an account as a first GitHub sign-in would and signs a session for
 * it, the same way the OAuth callback does. No avatar: the dashboard's CSP
 * only allows GitHub's real avatar host, which the run must not depend on.
 */
async function seedSession(pool: Pool, config: AppConfig): Promise<SessionFixture> {
  const id = randomUUID();
  await execute(
    pool,
    'INSERT INTO accounts (id, github_id, login, avatar_url) VALUES (?, ?, ?, NULL)',
    [id, 1, ACCOUNT_LOGIN],
  );
  const [pair = ''] = createSessionCookie(config, id).split(';');
  const separator = pair.indexOf('=');
  return {
    cookieName: pair.slice(0, separator),
    cookieValue: pair.slice(separator + 1),
    login: ACCOUNT_LOGIN,
  };
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
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      });
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
  for (const table of ['visitor_clicks', 'items', 'buttons', 'tenants', 'accounts']) {
    await pool.query(`DELETE FROM \`${table}\``);
  }

  // Before the app is built, as server.ts does, because the app serves the demo key.
  const demo = await ensureDemoButton(pool, config);
  const app = await buildApp({ config, pool, demoPublicKey: demo.publicKey });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  const fixture: E2eFixture = {
    ...(await registerButtons(await createTenant())),
    siteName: TENANT_NAME,
    demoKey: demo.publicKey,
    session: await seedSession(pool, config),
  };
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
