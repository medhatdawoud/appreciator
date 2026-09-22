import { createHmac } from 'node:crypto';

/**
 * Derives the per-visitor identifier stored in `visitor_clicks.visitor_hash`.
 *
 * The identity is built only from request properties the client does not
 * choose: source address and user agent. That is the whole point of doing
 * dedup server-side. An earlier version mixed in a client-generated id held in
 * localStorage, which meant clearing site data minted a new identity and a
 * fresh allowance — enforcing nothing that the client could not undo.
 *
 * What this buys, and what it costs, deliberately:
 *
 * - Clearing localStorage, cookies or using a private window does NOT grant a
 *   new allowance. This is the property the cap exists for.
 * - Visitors sharing an egress address AND a user agent share one allowance.
 *   Behind a corporate NAT or a mobile carrier, that is a real false positive,
 *   and it is the accepted cost of the guarantee above.
 * - Changing network or browser does yield a new allowance. Making that not so
 *   would require storing something far more invasive than this.
 *
 * Three properties of the construction matter:
 *
 * - It is keyed. A plain digest of (ip, userAgent) would let anyone who obtains
 *   the table confirm whether a given person clicked, since the inputs are
 *   low-entropy and enumerable. The HMAC key never leaves the server.
 * - It is not reversible into an IP address, so the click table holds no
 *   directly identifying data at rest.
 * - Components are length-prefixed, so ('ab', 'c') and ('a', 'bc') cannot
 *   collide by shifting characters across the delimiter.
 *
 * This depends on `request.ip` being the real client address. Behind a proxy
 * that means `TRUST_PROXY=true`; without it every visitor behind the proxy
 * resolves to the proxy's address and shares a single allowance.
 */
export function hashVisitor(
  secret: string,
  ip: string | undefined,
  userAgent: string | undefined,
): string {
  const parts = [ip ?? '', userAgent ?? ''];
  const message = parts.map((part) => `${part.length}:${part}`).join('|');
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}
