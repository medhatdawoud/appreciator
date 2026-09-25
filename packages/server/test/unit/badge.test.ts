import { describe, expect, it } from 'vitest';

import { assertSafeSvg } from '../../src/lib/svg-guard.js';
import { formatTotal, renderBadge, textWidth } from '../../src/lib/badge.js';

function attribute(svg: string, name: string): string | undefined {
  return new RegExp(`<svg[^>]* ${name}="([^"]*)"`).exec(svg)?.[1];
}

describe('formatTotal', () => {
  it('writes the exact total, grouped in thousands', () => {
    expect(formatTotal(0)).toBe('0');
    expect(formatTotal(999)).toBe('999');
    expect(formatTotal(1234)).toBe('1,234');
    expect(formatTotal(1234567)).toBe('1,234,567');
  });

  it('never shows a negative or fractional total', () => {
    expect(formatTotal(-3)).toBe('0');
    expect(formatTotal(12.7)).toBe('12');
  });
});

describe('textWidth', () => {
  it('grows with the text, digits all alike', () => {
    expect(textWidth('1,234')).toBeGreaterThan(textWidth('999'));
    expect(textWidth('111')).toBe(textWidth('888'));
    expect(textWidth('')).toBe(0);
  });
});

describe('renderBadge', () => {
  const badge = renderBadge({ label: 'appreciated', value: '1,234', color: '#e11d48' });

  it('names itself for screen readers and hovering', () => {
    expect(badge).toContain('role="img"');
    expect(attribute(badge, 'aria-label')).toBe('appreciated: 1,234');
    expect(badge).toContain('<title>appreciated: 1,234</title>');
  });

  it('shows the label and the value, the value on the colour', () => {
    expect(badge).toContain('>appreciated</text>');
    expect(badge).toContain('>1,234</text>');
    expect(badge).toContain('fill="#e11d48"');
  });

  it('is exactly as wide as its two halves, and widens with a longer value', () => {
    const width = Number(attribute(badge, 'width'));
    const halves = [...badge.matchAll(/<rect (?:x="\d+" )?width="(\d+)" height="20" fill="#/g)].map(
      (match) => Number(match[1]),
    );
    expect(halves).toHaveLength(2);
    expect(halves[0]! + halves[1]!).toBe(width);

    const longer = renderBadge({ label: 'appreciated', value: '1,234,567', color: '#e11d48' });
    expect(Number(attribute(longer, 'width'))).toBeGreaterThan(width);
  });

  it('gives each badge ids of its own, so badges pasted inline do not clip each other', () => {
    const other = renderBadge({ label: 'appreciated', value: '9', color: '#e11d48' });
    const ids = (svg: string) => [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);

    expect(ids(badge)).toHaveLength(2);
    expect(ids(other)).toHaveLength(2);
    expect(ids(badge).some((id) => ids(other).includes(id))).toBe(false);
    for (const id of ids(badge)) expect(badge).toContain(`url(#${id})`);
  });

  it("escapes whatever the label says, and passes the server's own SVG check", () => {
    const hostile = renderBadge({
      label: '<script>alert(1)</script> & "you"',
      value: '5',
      color: '#123456',
    });

    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;you&quot;');
    expect(() => assertSafeSvg(hostile, 'badge')).not.toThrow();
  });
});
