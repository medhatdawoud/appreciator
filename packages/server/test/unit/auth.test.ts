import { describe, expect, it } from 'vitest';

import {
  PUBLIC_KEY_PREFIX,
  SECRET_KEY_PREFIX,
  extractBearerToken,
  generatePublicKey,
  generateSecretKey,
  hashSecretKey,
  isOriginAllowed,
} from '../../src/lib/auth.js';

describe('generateSecretKey', () => {
  it('is prefixed and carries at least 256 bits of entropy', () => {
    const key = generateSecretKey();
    expect(key.startsWith(SECRET_KEY_PREFIX)).toBe(true);
    // 32 random bytes as base64url.
    expect(key.slice(SECRET_KEY_PREFIX.length)).toHaveLength(43);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateSecretKey()));
    expect(keys.size).toBe(200);
  });
});

describe('generatePublicKey', () => {
  it('is prefixed hex that fits the VARCHAR(64) column', () => {
    const key = generatePublicKey();
    expect(key.startsWith(PUBLIC_KEY_PREFIX)).toBe(true);
    expect(key.slice(PUBLIC_KEY_PREFIX.length)).toMatch(/^[0-9a-f]{32}$/);
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generatePublicKey()));
    expect(keys.size).toBe(200);
  });
});

describe('hashSecretKey', () => {
  it('produces a hex digest that fits the VARCHAR(255) column', () => {
    const hash = hashSecretKey(generateSecretKey());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const key = generateSecretKey();
    expect(hashSecretKey(key)).toBe(hashSecretKey(key));
  });

  it('does not contain the plaintext key', () => {
    const key = generateSecretKey();
    expect(hashSecretKey(key)).not.toContain(key.slice(SECRET_KEY_PREFIX.length));
  });

  it('differs for keys that differ by one character', () => {
    expect(hashSecretKey('apr_sk_aaaa')).not.toBe(hashSecretKey('apr_sk_aaab'));
  });
});

describe('extractBearerToken', () => {
  it('reads the token from a well-formed header', () => {
    expect(extractBearerToken('Bearer apr_sk_abc')).toBe('apr_sk_abc');
  });

  it('accepts any casing of the scheme', () => {
    expect(extractBearerToken('bearer apr_sk_abc')).toBe('apr_sk_abc');
    expect(extractBearerToken('BEARER apr_sk_abc')).toBe('apr_sk_abc');
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(extractBearerToken('  Bearer   apr_sk_abc  ')).toBe('apr_sk_abc');
  });

  it('rejects a missing header', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('rejects other auth schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('apr_sk_abc')).toBeUndefined();
  });

  it('rejects an empty token', () => {
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });

  it('rejects a token containing whitespace', () => {
    expect(extractBearerToken('Bearer abc def')).toBeUndefined();
  });

  it('rejects an absurdly long token rather than hashing it', () => {
    expect(extractBearerToken(`Bearer ${'a'.repeat(100_000)}`)).toBeUndefined();
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['https://example.com', 'https://blog.example.com'];

  it('accepts a listed origin', () => {
    expect(isOriginAllowed('https://example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://blog.example.com', allowed)).toBe(true);
  });

  it('rejects an unlisted origin', () => {
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
  });

  it('rejects a lookalike that merely starts with a listed origin', () => {
    expect(isOriginAllowed('https://example.com.evil.test', allowed)).toBe(false);
  });

  it('rejects the same host over a different scheme', () => {
    expect(isOriginAllowed('http://example.com', allowed)).toBe(false);
  });

  it('rejects the same host on a different port', () => {
    expect(isOriginAllowed('https://example.com:8443', allowed)).toBe(false);
  });

  it('ignores host casing and a trailing slash on either side', () => {
    expect(isOriginAllowed('https://EXAMPLE.com/', allowed)).toBe(true);
    expect(isOriginAllowed('https://example.com', ['https://Example.com/'])).toBe(true);
  });

  it('rejects everything when the allowlist is empty', () => {
    expect(isOriginAllowed('https://example.com', [])).toBe(false);
  });

  it('rejects the sandboxed "null" origin unless it is listed explicitly', () => {
    expect(isOriginAllowed('null', allowed)).toBe(false);
    expect(isOriginAllowed('null', ['null'])).toBe(true);
  });

  it('accepts any origin when the allowlist opts out with *', () => {
    expect(isOriginAllowed('https://anything.test', ['*'])).toBe(true);
  });
});
