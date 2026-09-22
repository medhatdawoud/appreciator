/**
 * Coarse safety check on tenant-supplied SVG.
 *
 * `svgSource` is stored verbatim and later rendered *inside pages belonging to
 * the tenant's own visitors*, so a hostile icon is a stored-XSS vector against
 * third-party sites. The management API is authenticated, which makes this
 * defence in depth rather than the primary control: it limits the damage a
 * compromised or careless tenant account can do.
 *
 * It is deliberately a denylist of the constructs that execute script, not a
 * parser. Treat it as a guard rail, not a sanitiser — the widget still must not
 * hand this string to anything that would run it.
 */

/** 64 KiB. Comfortably more than any icon needs, far less than MEDIUMTEXT allows. */
export const MAX_SVG_BYTES = 64 * 1024;

export class SvgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgValidationError';
  }
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /<\s*script\b/i, reason: 'contains a <script> element' },
  { pattern: /<\s*foreignObject\b/i, reason: 'contains a <foreignObject> element' },
  { pattern: /<\s*(iframe|embed|object)\b/i, reason: 'contains an embedded-content element' },
  {
    pattern: /<\s*set\b|<\s*animate\b[^>]*attributeName\s*=\s*["']?href/i,
    reason: 'contains an animation that can rewrite a link target',
  },
  { pattern: /\bon[a-z]+\s*=/i, reason: 'contains an inline event handler attribute' },
  { pattern: /javascript\s*:/i, reason: 'contains a javascript: URL' },
  { pattern: /data\s*:\s*text\/html/i, reason: 'contains a data: URL with HTML content' },
  { pattern: /<!ENTITY\b/i, reason: 'declares an XML entity' },
];

/**
 * Throws `SvgValidationError` if `source` is not something we are willing to store.
 * `field` names the input in the message, so a caller sending several icons
 * is told which one was refused.
 */
export function assertSafeSvg(source: string, field = 'svgSource'): void {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SVG_BYTES) {
    throw new SvgValidationError(`${field} must be at most ${MAX_SVG_BYTES} bytes`);
  }

  if (!/<\s*svg\b/i.test(source)) {
    throw new SvgValidationError(`${field} must contain an <svg> element`);
  }

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      throw new SvgValidationError(`${field} ${reason}`);
    }
  }
}
