import { describe, expect, it } from 'vitest';

import { hashVisitor } from '../../src/lib/visitor-hash.js';

const SECRET = 'unit-test-secret-0123456789abcdef';

describe('hashVisitor', () => {
  it('returns a 64-character lowercase hex digest, matching CHAR(64)', () => {
    const hash = hashVisitor(SECRET, 'visitor-1', '203.0.113.1', 'Mozilla/5.0');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const args = [SECRET, 'visitor-1', '203.0.113.1', 'Mozilla/5.0'] as const;
    expect(hashVisitor(...args)).toBe(hashVisitor(...args));
  });

  it('changes when the visitor id changes', () => {
    expect(hashVisitor(SECRET, 'visitor-1', '203.0.113.1', 'UA')).not.toBe(
      hashVisitor(SECRET, 'visitor-2', '203.0.113.1', 'UA'),
    );
  });

  it('changes when the ip changes', () => {
    expect(hashVisitor(SECRET, 'v', '203.0.113.1', 'UA')).not.toBe(
      hashVisitor(SECRET, 'v', '203.0.113.2', 'UA'),
    );
  });

  it('changes when the user agent changes', () => {
    expect(hashVisitor(SECRET, 'v', '203.0.113.1', 'UA-a')).not.toBe(
      hashVisitor(SECRET, 'v', '203.0.113.1', 'UA-b'),
    );
  });

  it('changes when the secret changes, so the digest is genuinely keyed', () => {
    expect(hashVisitor(SECRET, 'v', '203.0.113.1', 'UA')).not.toBe(
      hashVisitor(`${SECRET}-other`, 'v', '203.0.113.1', 'UA'),
    );
  });

  it('treats a missing ip or user agent as an empty component', () => {
    expect(hashVisitor(SECRET, 'v', undefined, undefined)).toBe(hashVisitor(SECRET, 'v', '', ''));
  });

  it('does not let characters shift across component boundaries', () => {
    // Without length-prefixing, ('ab', 'c') and ('a', 'bc') would both hash the
    // concatenation "abc" and collide into one visitor allowance.
    expect(hashVisitor(SECRET, 'ab', 'c', '')).not.toBe(hashVisitor(SECRET, 'a', 'bc', ''));
  });

  it('does not leak the ip address into the digest', () => {
    const ip = '203.0.113.99';
    expect(hashVisitor(SECRET, 'v', ip, 'UA')).not.toContain(Buffer.from(ip).toString('hex'));
  });
});
