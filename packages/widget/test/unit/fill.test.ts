import { describe, expect, it } from 'vitest';

import { clipInsetTop, drawingBounds } from '../../src/fill.js';

// The Feather heart: viewBox 0 0 24 24, geometry from y≈3.0 to y≈21.23,
// stroke-width 2, drawn in a square box.
const heart = {
  viewBox: { y: 0, width: 24, height: 24 },
  box: { width: 48, height: 48 },
  bbox: { y: 3, height: 18.23 },
  strokeWidth: 2,
};

describe('drawingBounds', () => {
  it('measures the empty space above and below the drawing, strokes included', () => {
    expect(drawingBounds(heart)).toEqual({ top: 8.33, bottom: 7.38 });
  });

  it('accounts for letterboxing when the box is taller than the viewBox', () => {
    // A 24×12 viewBox in a square box is centred with 25% empty above and below.
    expect(
      drawingBounds({
        viewBox: { y: 0, width: 24, height: 12 },
        box: { width: 40, height: 40 },
        bbox: { y: 0, height: 12 },
        strokeWidth: 0,
      }),
    ).toEqual({ top: 25, bottom: 25 });
  });

  it('clamps a stroke that would spill past the viewBox', () => {
    expect(
      drawingBounds({
        viewBox: { y: 0, width: 10, height: 10 },
        box: { width: 10, height: 10 },
        bbox: { y: 0, height: 10 },
        strokeWidth: 4,
      }),
    ).toEqual({ top: 0, bottom: 0 });
  });

  it('gives up on anything unmeasured', () => {
    expect(drawingBounds({ ...heart, box: { width: 0, height: 0 } })).toBeNull();
    expect(drawingBounds({ ...heart, viewBox: { y: 0, width: 0, height: 0 } })).toBeNull();
    expect(drawingBounds({ ...heart, bbox: { y: 0, height: 0 } })).toBeNull();
    expect(drawingBounds({ ...heart, bbox: { y: 0, height: Number.NaN } })).toBeNull();
  });
});

describe('clipInsetTop', () => {
  const bounds = { top: 8.33, bottom: 7.38 };

  it('hides everything at 0 and reveals exactly the drawing at 100', () => {
    expect(clipInsetTop(0, bounds)).toBe(100);
    expect(clipInsetTop(100, bounds)).toBe(8.33);
    expect(clipInsetTop(150, bounds)).toBe(8.33);
  });

  it('maps progress onto the drawing rather than the box', () => {
    // 19% of the heart: the top of the fill sits 81% of the way down the drawing.
    expect(clipInsetTop(19, bounds)).toBe(76.6);
    expect(clipInsetTop(19, null)).toBe(81);
  });
});
