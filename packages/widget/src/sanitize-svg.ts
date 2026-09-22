/**
 * Parses tenant-supplied SVG into a DOM subtree that cannot run script.
 *
 * The server refuses to store the obvious vectors, but this markup ends up
 * inside pages that belong to the tenant's visitors, so the widget applies its
 * own check rather than trusting what it was handed. Parsing as XML (never
 * `innerHTML`) keeps the markup inert while it is inspected.
 */

const FORBIDDEN_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'embed', 'object', 'set']);

const UNSAFE_URL = /^\s*(javascript:|data:\s*text\/html)/i;

/**
 * Where an icon's `style` attributes travel while the markup is parsed.
 *
 * A parser applies a `style` attribute as inline style, and a host page whose
 * Content-Security-Policy has a `style-src` without `'unsafe-inline'` refuses
 * that, logging a violation and leaving the icon unpainted. Setting the same
 * declarations through the CSSOM is outside that policy, so the attributes
 * are renamed before parsing and moved back onto `element.style` after.
 */
const HELD_STYLE_ATTRIBUTE = 'data-appreciator-style';

function holdStyleAttributes(source: string): string {
  return source.replace(/<[^>]+>/g, (tag) =>
    tag.replace(/(\s)style(\s*=)/gi, `$1${HELD_STYLE_ATTRIBUTE}$2`),
  );
}

function releaseStyleAttributes(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll(`[${HELD_STYLE_ATTRIBUTE}]`))]) {
    const held = element.getAttribute(HELD_STYLE_ATTRIBUTE);
    if (held === null) continue;
    element.removeAttribute(HELD_STYLE_ATTRIBUTE);
    (element as Element & ElementCSSInlineStyle).style.cssText = held;
  }
}

export function parseSafeSvg(source: string, target: Document = document): Element | null {
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(holdStyleAttributes(source), 'image/svg+xml');
  } catch {
    return null;
  }

  const root = parsed.documentElement;
  if (
    root === null ||
    root.localName !== 'svg' ||
    parsed.getElementsByTagName('parsererror').length > 0
  ) {
    return null;
  }

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || (name.endsWith('href') && UNSAFE_URL.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const svg = target.importNode(root, true);
  releaseStyleAttributes(svg);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}
