import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionCookie,
  isCsrfSafe,
  readSession,
  signToken,
  verifyToken,
} from '../../src/lib/session.js';

const SECRET = 'session-secret-0123456789abcdef0123';
const config = { sessionSecret: SECRET, publicBaseUrl: 'https://appreciator.test' };
const ACCOUNT_ID = '11111111-2222-3333-4444-555555555555';

/** The cookie's value out of a Set-Cookie header value. */
function valueOf(setCookie: string): string {
  const [pair] = setCookie.split(';');
  return decodeURIComponent((pair ?? '').slice(`${SESSION_COOKIE}=`.length));
}

function attributesOf(setCookie: string): string[] {
  return setCookie
    .split(';')
    .slice(1)
    .map((attribute) => attribute.trim().toLowerCase());
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session cookies', () => {
  it('round-trips the account id', () => {
    const cookie = createSessionCookie(config, ACCOUNT_ID);

    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(readSession(config, valueOf(cookie))).toEqual({ accountId: ACCOUNT_ID });
  });

  it('is HttpOnly, SameSite=Lax, site-wide, and lasts seven days', () => {
    const attributes = attributesOf(createSessionCookie(config, ACCOUNT_ID));

    expect(attributes).toContain('httponly');
    expect(attributes).toContain('samesite=lax');
    expect(attributes).toContain('path=/');
    expect(attributes).toContain(`max-age=${7 * 24 * 60 * 60}`);
  });

  it('is Secure only when the deployment is served over https', () => {
    expect(attributesOf(createSessionCookie(config, ACCOUNT_ID))).toContain('secure');
    expect(
      attributesOf(
        createSessionCookie({ ...config, publicBaseUrl: 'http://localhost:3000' }, ACCOUNT_ID),
      ),
    ).not.toContain('secure');
  });

  it('is cleared by an empty, already-expired cookie', () => {
    const cleared = clearSessionCookie(config);

    expect(valueOf(cleared)).toBe('');
    expect(attributesOf(cleared)).toContain('max-age=0');
  });

  it('rejects a tampered payload', () => {
    const [, signature] = valueOf(createSessionCookie(config, ACCOUNT_ID)).split('.');
    const forged = Buffer.from(
      JSON.stringify({ accountId: 'someone-else', exp: 9_999_999_999 }),
    ).toString('base64url');

    expect(readSession(config, `${forged}.${signature}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const [body, signature = ''] = valueOf(createSessionCookie(config, ACCOUNT_ID)).split('.');
    // The first character, not the last: the last of 43 base64url characters
    // carries two padding bits, so some edits there decode to the same bytes.
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

    expect(readSession(config, `${body}.${flipped}`)).toBeNull();
  });

  it('rejects a cookie signed with another secret', () => {
    const cookie = createSessionCookie(
      { ...config, sessionSecret: 'another-secret-0123456789abcdef0123' },
      ACCOUNT_ID,
    );

    expect(readSession(config, valueOf(cookie))).toBeNull();
  });

  it('rejects an expired cookie', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cookie = createSessionCookie(config, ACCOUNT_ID);

    vi.setSystemTime(new Date('2026-01-07T23:59:00Z'));
    expect(readSession(config, valueOf(cookie))).toEqual({ accountId: ACCOUNT_ID });

    vi.setSystemTime(new Date('2026-01-08T00:00:01Z'));
    expect(readSession(config, valueOf(cookie))).toBeNull();
  });

  it('rejects malformed values', () => {
    for (const value of [undefined, '', 'abc', 'a.b.c', '.', 'not-base64.!!!']) {
      expect(readSession(config, value), `value ${String(value)}`).toBeNull();
    }
  });

  it('rejects a validly signed token without an account id or expiry', () => {
    expect(readSession(config, signToken(SECRET, { exp: 9_999_999_999 }))).toBeNull();
    expect(readSession(config, signToken(SECRET, { accountId: ACCOUNT_ID }))).toBeNull();
  });

  it('reads nobody as signed in when there is no session secret', () => {
    const cookie = createSessionCookie(config, ACCOUNT_ID);

    expect(readSession({ ...config, sessionSecret: undefined }, valueOf(cookie))).toBeNull();
  });
});

describe('verifyToken', () => {
  it('returns the payload of a valid token', () => {
    const token = signToken(SECRET, { state: 'abc', exp: 9_999_999_999 });

    expect(verifyToken(SECRET, token)).toEqual({ state: 'abc', exp: 9_999_999_999 });
  });

  it('rejects a signed payload that is not an object', () => {
    const body = Buffer.from('"just a string"').toString('base64url');
    const signed = signToken(SECRET, {}).split('.')[1];

    expect(verifyToken(SECRET, `${body}.${signed}`)).toBeNull();
  });
});

describe('isCsrfSafe', () => {
  const ORIGIN = 'https://appreciator.test';
  const header = { [CSRF_HEADER]: CSRF_HEADER_VALUE };

  it('lets reads through without any header', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isCsrfSafe(method, {}, ORIGIN)).toBe(true);
    }
  });

  it('accepts a write with the header from the dashboard origin', () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      expect(isCsrfSafe(method, { ...header, origin: ORIGIN }, ORIGIN)).toBe(true);
    }
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    expect(isCsrfSafe('POST', { ...header, referer: `${ORIGIN}/dashboard?x=1` }, ORIGIN)).toBe(
      true,
    );
  });

  it('refuses a write without the header', () => {
    expect(isCsrfSafe('POST', { origin: ORIGIN }, ORIGIN)).toBe(false);
  });

  it('refuses a write with the wrong header value', () => {
    expect(isCsrfSafe('POST', { [CSRF_HEADER]: 'XMLHttpRequest', origin: ORIGIN }, ORIGIN)).toBe(
      false,
    );
  });

  it('refuses a write from another origin', () => {
    expect(isCsrfSafe('POST', { ...header, origin: 'https://evil.test' }, ORIGIN)).toBe(false);
    expect(isCsrfSafe('POST', { ...header, origin: 'http://appreciator.test' }, ORIGIN)).toBe(
      false,
    );
    expect(
      isCsrfSafe('POST', { ...header, origin: 'https://appreciator.test.evil.test' }, ORIGIN),
    ).toBe(false);
  });

  it('prefers Origin over Referer when both are present', () => {
    expect(
      isCsrfSafe(
        'POST',
        { ...header, origin: 'https://evil.test', referer: `${ORIGIN}/dashboard` },
        ORIGIN,
      ),
    ).toBe(false);
  });

  it('refuses a write that names no origin at all', () => {
    expect(isCsrfSafe('POST', header, ORIGIN)).toBe(false);
  });

  it('refuses the opaque "null" origin and a malformed Referer', () => {
    expect(isCsrfSafe('POST', { ...header, origin: 'null' }, ORIGIN)).toBe(false);
    expect(isCsrfSafe('POST', { ...header, referer: 'not a url' }, ORIGIN)).toBe(false);
  });
});
