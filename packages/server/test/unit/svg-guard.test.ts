import { describe, expect, it } from 'vitest';

import { MAX_SVG_BYTES, SvgValidationError, assertSafeSvg } from '../../src/lib/svg-guard.js';

const HEART =
  '<svg viewBox="0 0 24 24"><path d="M12 21s-8-4.5-8-10a4 4 0 018-1 4 4 0 018 1c0 5.5-8 10-8 10z"/></svg>';

describe('assertSafeSvg', () => {
  it('accepts an ordinary icon', () => {
    expect(() => assertSafeSvg(HEART)).not.toThrow();
  });

  it('accepts an svg with a namespace declaration and attributes', () => {
    expect(() =>
      assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="none"><circle r="4"/></svg>'),
    ).not.toThrow();
  });

  it('requires an <svg> element', () => {
    expect(() => assertSafeSvg('<div>not an icon</div>')).toThrow(SvgValidationError);
  });

  it('rejects a <script> element', () => {
    expect(() => assertSafeSvg('<svg><script>alert(1)</script></svg>')).toThrow(SvgValidationError);
  });

  it('rejects a <script> element hidden behind whitespace', () => {
    expect(() => assertSafeSvg('<svg><  script>alert(1)</script></svg>')).toThrow(
      SvgValidationError,
    );
  });

  it('rejects an inline event handler', () => {
    expect(() => assertSafeSvg('<svg onload="alert(1)"><path/></svg>')).toThrow(SvgValidationError);
    expect(() => assertSafeSvg('<svg><circle onclick = "steal()"/></svg>')).toThrow(
      SvgValidationError,
    );
  });

  it('rejects a javascript: URL', () => {
    expect(() => assertSafeSvg('<svg><a href="javascript:alert(1)"><path/></a></svg>')).toThrow(
      SvgValidationError,
    );
  });

  it('rejects <foreignObject>, which can carry arbitrary HTML', () => {
    expect(() => assertSafeSvg('<svg><foreignObject><b>hi</b></foreignObject></svg>')).toThrow(
      SvgValidationError,
    );
  });

  it('rejects embedded-content elements', () => {
    expect(() => assertSafeSvg('<svg><iframe src="https://evil.test"></iframe></svg>')).toThrow(
      SvgValidationError,
    );
  });

  it('rejects a data: URL carrying HTML', () => {
    expect(() =>
      assertSafeSvg('<svg><image href="data:text/html,<script>x</script>"/></svg>'),
    ).toThrow(SvgValidationError);
  });

  it('rejects an XML entity declaration', () => {
    expect(() =>
      assertSafeSvg('<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg/>'),
    ).toThrow(SvgValidationError);
  });

  it('rejects a source larger than the byte cap', () => {
    const padded = `<svg>${'a'.repeat(MAX_SVG_BYTES)}</svg>`;
    expect(() => assertSafeSvg(padded)).toThrow(SvgValidationError);
  });

  it('measures the cap in bytes, not characters', () => {
    // Each 'é' is two UTF-8 bytes, so this is under the character count but
    // over the byte cap.
    const multibyte = `<svg>${'é'.repeat(MAX_SVG_BYTES - 100)}</svg>`;
    expect(multibyte.length).toBeLessThan(MAX_SVG_BYTES);
    expect(() => assertSafeSvg(multibyte)).toThrow(SvgValidationError);
  });
});
