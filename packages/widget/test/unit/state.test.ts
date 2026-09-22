import type { ClickCounts } from '@appreciator/shared';
import { describe, expect, it } from 'vitest';

import { canClick, optimisticClick, visualState } from '../../src/state.js';

const fresh: ClickCounts = {
  totalCount: 20,
  maxClicks: 3,
  visitorCount: 0,
  visitorRemaining: 3,
  maxed: false,
};

describe('visualState', () => {
  it('is default until maxed, and clicked while pulsing', () => {
    expect(visualState(null, false)).toBe('default');
    expect(visualState(fresh, false)).toBe('default');
    expect(visualState(fresh, true)).toBe('clicked');
    expect(visualState({ ...fresh, maxed: true }, false)).toBe('full');
    expect(visualState({ ...fresh, maxed: true }, true)).toBe('clicked');
  });
});

describe('canClick', () => {
  it('needs counts that are not maxed', () => {
    expect(canClick(null)).toBe(false);
    expect(canClick(fresh)).toBe(true);
    expect(canClick({ ...fresh, maxed: true })).toBe(false);
  });
});

describe('optimisticClick', () => {
  it('advances both counters and flips maxed on the last click', () => {
    const two = optimisticClick(optimisticClick(fresh));
    expect(two).toEqual({ ...fresh, totalCount: 22, visitorCount: 2, visitorRemaining: 1 });

    const three = optimisticClick(two);
    expect(three).toEqual({
      ...fresh,
      totalCount: 23,
      visitorCount: 3,
      visitorRemaining: 0,
      maxed: true,
    });
  });

  it('is a no-op once maxed', () => {
    const maxed = { ...fresh, visitorCount: 3, visitorRemaining: 0, maxed: true };
    expect(optimisticClick(maxed)).toBe(maxed);
  });
});
