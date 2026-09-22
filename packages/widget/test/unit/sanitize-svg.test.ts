import { describe, expect, it } from 'vitest';

import { parseSafeSvg } from '../../src/sanitize-svg.js';

const NS = 'http://www.w3.org/2000/svg';

describe('parseSafeSvg', () => {
  it('keeps the icon structure and marks it decorative', () => {
    const svg = parseSafeSvg(
      `<svg xmlns="${NS}" viewBox="0 0 24 24" style="fill: var(--appr-fill, none)"><path d="M1 1h2"/></svg>`,
    );

    expect(svg?.localName).toBe('svg');
    expect(svg?.namespaceURI).toBe(NS);
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('style')).toContain('--appr-fill');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M1 1h2');
  });

  it('drops script-bearing elements and attributes', () => {
    const svg = parseSafeSvg(
      `<svg xmlns="${NS}" onload="alert(1)">` +
        `<script>alert(1)</script>` +
        `<foreignObject><div/></foreignObject>` +
        `<a href="javascript:alert(1)" onclick="x()"><path d="M0 0" onmouseover="y()"/></a>` +
        `<a href="https://example.test/ok"><rect/></a>` +
        `</svg>`,
    );

    expect(svg).not.toBeNull();
    expect(svg?.outerHTML).not.toMatch(/script|foreignObject|javascript:|on[a-z]+=/i);
    expect(svg?.querySelectorAll('a')).toHaveLength(2);
    expect(svg?.querySelectorAll('a')[1]?.getAttribute('href')).toBe('https://example.test/ok');
    expect(svg?.querySelector('path')).not.toBeNull();
  });

  it('rejects anything whose root is not <svg>', () => {
    expect(parseSafeSvg('<div>hello</div>')).toBeNull();
    expect(parseSafeSvg('')).toBeNull();
    expect(parseSafeSvg('<svg')).toBeNull();
  });
});
