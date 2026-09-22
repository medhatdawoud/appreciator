import { createHmac } from 'node:crypto';

/**
 * Derives the per-visitor identifier stored in `visitor_clicks.visitor_hash`.
 *
 * Three properties matter here:
 *
 * - It is keyed. A plain digest of (visitorId, ip, userAgent) would let anyone
 *   who obtains the table confirm whether a given person clicked, since the
 *   inputs are low-entropy and enumerable. The HMAC key never leaves the server.
 * - It is not reversible into an IP address, so the click table holds no
 *   directly identifying data at rest.
 * - Components are length-prefixed, so ('ab', 'c') and ('a', 'bc') cannot
 *   collide by shifting characters across the delimiter.
 *
 * Binding the hash to IP and user agent means a visitor who changes network or
 * browser gets a fresh allowance. That is the intended trade: the client-side
 * visitor id alone is trivially reset, and treating this as a hard identity
 * would mean storing something far more invasive.
 */
export function hashVisitor(
  secret: string,
  visitorId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): string {
  const parts = [visitorId, ip ?? '', userAgent ?? ''];
  const message = parts.map((part) => `${part.length}:${part}`).join('|');
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}
