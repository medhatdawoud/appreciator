import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { upsertAccount } from '../../src/db/accounts.js';
import { execute, queryRows } from '../../src/db/pool.js';
import { OAUTH_STATE_COOKIE } from '../../src/routes/auth.js';
import { SESSION_COOKIE, signToken, verifyToken } from '../../src/lib/session.js';
import {
  SIGN_IN_CONFIG,
  closeTestContext,
  createTestContext,
  seedAccount,
  sessionHeaders,
  type TestContext,
} from './helpers.js';

const SESSION_SECRET = SIGN_IN_CONFIG.sessionSecret ?? '';

/** Every Set-Cookie header on a response, as an array. */
function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function cookieNamed(headers: Record<string, unknown>, name: string): string | undefined {
  return setCookies(headers).find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieValue(setCookie: string): string {
  const [pair = ''] = setCookie.split(';');
  return pair.slice(pair.indexOf('=') + 1);
}

describe('auth routes', () => {
  const contexts: TestContext[] = [];

  async function context(overrides = SIGN_IN_CONFIG): Promise<TestContext> {
    const created = await createTestContext(overrides);
    contexts.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((created) => closeTestContext(created)));
  });

  describe('GET /auth/github', () => {
    it('is 404 sign_in_disabled when sign-in is not configured', async () => {
      const { app } = await context({});

      const response = await app.inject({ method: 'GET', url: '/auth/github' });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('sign_in_disabled');
    });

    it("redirects to GitHub's authorize page with a state bound to a signed cookie", async () => {
      const { app } = await context();

      const response = await app.inject({ method: 'GET', url: '/auth/github' });

      expect(response.statusCode).toBe(302);
      const location = new URL(String(response.headers.location));
      expect(`${location.origin}${location.pathname}`).toBe(
        'https://github.test/login/oauth/authorize',
      );
      expect(location.searchParams.get('client_id')).toBe('Iv1.test-client');
      expect(location.searchParams.get('scope')).toBe('read:user');
      expect(location.searchParams.get('redirect_uri')).toBe(
        'https://appreciator.test/auth/github/callback',
      );

      const stateCookie = cookieNamed(response.headers, OAUTH_STATE_COOKIE);
      expect(stateCookie).toBeDefined();
      expect(stateCookie).toMatch(/HttpOnly/);
      expect(stateCookie).toMatch(/SameSite=Lax/);
      expect(stateCookie).toMatch(/Max-Age=600/);
      const payload = verifyToken(SESSION_SECRET, cookieValue(stateCookie ?? ''));
      expect(payload?.state).toBe(location.searchParams.get('state'));
    });

    it('uses a fresh state every time', async () => {
      const { app } = await context();

      const first = await app.inject({ method: 'GET', url: '/auth/github' });
      const second = await app.inject({ method: 'GET', url: '/auth/github' });

      expect(new URL(String(first.headers.location)).searchParams.get('state')).not.toBe(
        new URL(String(second.headers.location)).searchParams.get('state'),
      );
    });
  });

  describe('GET /auth/github/callback', () => {
    function stateCookie(state: string, secret = SESSION_SECRET, exp = 9_999_999_999): string {
      return `${OAUTH_STATE_COOKIE}=${signToken(secret, { state, exp })}`;
    }

    it('is 404 sign_in_disabled when sign-in is not configured', async () => {
      const { app } = await context({});

      const response = await app.inject({
        method: 'GET',
        url: '/auth/github/callback?code=c&state=s',
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a callback with no state cookie', async () => {
      const { app } = await context();

      const response = await app.inject({
        method: 'GET',
        url: '/auth/github/callback?code=c&state=s',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_state');
      expect(cookieNamed(response.headers, SESSION_COOKIE)).toBeUndefined();
    });

    it('refuses a state that does not match the cookie', async () => {
      const { app } = await context();

      const response = await app.inject({
        method: 'GET',
        url: '/auth/github/callback?code=c&state=attacker',
        headers: { cookie: stateCookie('mine') },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_state');
    });

    it('refuses a state cookie signed with another secret, or expired', async () => {
      const { app } = await context();

      for (const cookie of [
        stateCookie('s', 'another-secret-0123456789abcdef012345'),
        stateCookie('s', SESSION_SECRET, 1),
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/github/callback?code=c&state=s',
          headers: { cookie },
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('sends a cancelled consent back to the landing page and clears the state', async () => {
      const { app } = await context();

      const response = await app.inject({
        method: 'GET',
        url: '/auth/github/callback?error=access_denied&state=s',
        headers: { cookie: stateCookie('s') },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/?error=sign_in_failed');
      expect(cookieNamed(response.headers, OAUTH_STATE_COOKIE)).toMatch(/Max-Age=0/);
      expect(cookieNamed(response.headers, SESSION_COOKIE)).toBeUndefined();
    });
  });

  describe('GET /auth/me', () => {
    it('is 401 unauthenticated without a session', async () => {
      const { app } = await context();

      const response = await app.inject({ method: 'GET', url: '/auth/me' });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('unauthenticated');
    });

    it('returns the signed-in account', async () => {
      const { app, pool, config } = await context();
      const account = await seedAccount(pool);

      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: sessionHeaders(config, account.id).cookie ?? '' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: account.id,
        login: 'octocat',
        avatarUrl: `https://avatars.githubusercontent.test/u/${account.githubId}`,
      });
    });

    it('treats a session for a deleted account as signed out', async () => {
      const { app, pool, config } = await context();
      const account = await seedAccount(pool);
      const { cookie = '' } = sessionHeaders(config, account.id);
      await execute(pool, 'DELETE FROM accounts WHERE id = ?', [account.id]);

      const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('unauthenticated');
    });

    it('rejects a session signed with another secret', async () => {
      const { app, pool, config } = await context();
      const account = await seedAccount(pool);
      const { cookie = '' } = sessionHeaders(
        { ...config, sessionSecret: 'another-secret-0123456789abcdef012345' },
        account.id,
      );

      const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });

      expect(response.statusCode).toBe(401);
    });

    it('is rate limited per IP', async () => {
      const { app } = await context();

      const response = await app.inject({ method: 'GET', url: '/auth/me' });

      expect(response.headers['x-ratelimit-limit']).toBeDefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('clears the session cookie', async () => {
      const { app, pool, config } = await context();
      const account = await seedAccount(pool);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: sessionHeaders(config, account.id),
      });

      expect(response.statusCode).toBe(204);
      const cleared = cookieNamed(response.headers, SESSION_COOKIE);
      expect(cleared).toMatch(/^appreciator_session=;/);
      expect(cleared).toMatch(/Max-Age=0/);
    });

    it('is refused without the CSRF header', async () => {
      const { app, pool, config } = await context();
      const account = await seedAccount(pool);
      const { cookie = '', origin = '' } = sessionHeaders(config, account.id);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie, origin },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('csrf');
      expect(cookieNamed(response.headers, SESSION_COOKIE)).toBeUndefined();
    });

    it('is refused from another origin', async () => {
      const { app, pool, config } = await context();
      const account = await seedAccount(pool);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { ...sessionHeaders(config, account.id), origin: 'https://evil.test' },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});

describe('upsertAccount', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(context);
  });

  const identity = { githubId: 583231, login: 'octocat', avatarUrl: 'https://a.test/1' };

  it('creates the account on first sign-in and finds it by GitHub id afterwards', async () => {
    const first = await upsertAccount(context.pool, identity);
    const second = await upsertAccount(context.pool, identity);

    expect(second.id).toBe(first.id);
    expect(await queryRows(context.pool, 'SELECT id FROM accounts')).toHaveLength(1);
  });

  it('follows a renamed login and a new avatar', async () => {
    const first = await upsertAccount(context.pool, identity);
    const renamed = await upsertAccount(context.pool, {
      ...identity,
      login: 'octocat-renamed',
      avatarUrl: null,
    });

    expect(renamed).toMatchObject({ id: first.id, login: 'octocat-renamed', avatar_url: null });
  });

  it('converges on one account when first sign-ins race', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => upsertAccount(context.pool, identity)),
    );

    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await queryRows(context.pool, 'SELECT id FROM accounts')).toHaveLength(1);
  });
});
