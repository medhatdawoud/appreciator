import { describe, expect, it } from 'vitest';

import { hashVisitor } from '../../src/lib/visitor-hash.js';

const SECRET = 'unit-test-secret-0123456789abcdef';
const IP = '203.0.113.1';
const UA = 'Mozilla/5.0';

describe('hashVisitor', () => {
  it('returns a 64-character lowercase hex digest, matching CHAR(64)', () => {
    expect(hashVisitor(SECRET, IP, UA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(hashVisitor(SECRET, IP, UA)).toBe(hashVisitor(SECRET, IP, UA));
  });

  it('depends on nothing but the secret, ip and user agent', () => {
    // The whole point of the change: identity is a function of request
    // properties the client does not choose. There is no third input a client
    // could vary to mint itself a new allowance.
    expect(hashVisitor.length).toBe(3);
  });

  it('changes when the ip changes', () => {
    expect(hashVisitor(SECRET, IP, UA)).not.toBe(hashVisitor(SECRET, '203.0.113.2', UA));
  });

  it('changes when the user agent changes', () => {
    expect(hashVisitor(SECRET, IP, 'UA-a')).not.toBe(hashVisitor(SECRET, IP, 'UA-b'));
  });

  it('changes when the secret changes, so the digest is genuinely keyed', () => {
    expect(hashVisitor(SECRET, IP, UA)).not.toBe(hashVisitor(`${SECRET}-other`, IP, UA));
  });

  it('treats a missing ip or user agent as an empty component', () => {
    expect(hashVisitor(SECRET, undefined, undefined)).toBe(hashVisitor(SECRET, '', ''));
  });

  it('does not let characters shift across the component boundary', () => {
    // Without length-prefixing, ('ab', 'c') and ('a', 'bc') would both hash the
    // concatenation "abc" and collide into one visitor allowance.
    expect(hashVisitor(SECRET, 'ab', 'c')).not.toBe(hashVisitor(SECRET, 'a', 'bc'));
  });

  it('does not collide when an ip contains the delimiter', () => {
    expect(hashVisitor(SECRET, '1|2', '3')).not.toBe(hashVisitor(SECRET, '1', '2|3'));
  });

  it('does not leak the ip address into the digest', () => {
    expect(hashVisitor(SECRET, IP, UA)).not.toContain(Buffer.from(IP).toString('hex'));
  });
});
