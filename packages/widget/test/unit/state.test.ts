import type { ClickCounts } from '@appreciator/shared';
import { describe, expect, it } from 'vitest';

import {
  canClick,
  fillPercent,
  optimisticClick,
  progressPercent,
  visualState,
} from '../../src/state.js';

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

describe('progressPercent', () => {
  it('is the share of the allowance spent, rounded to a whole percent', () => {
    expect(progressPercent(null)).toBe(0);
    expect(progressPercent({ ...fresh, maxClicks: 10, visitorCount: 0 })).toBe(0);
    expect(progressPercent({ ...fresh, maxClicks: 10, visitorCount: 3 })).toBe(30);
    expect(progressPercent({ ...fresh, maxClicks: 3, visitorCount: 1 })).toBe(33);
    expect(progressPercent({ ...fresh, maxClicks: 3, visitorCount: 3, maxed: true })).toBe(100);
  });

  it('stays within 0 to 100 for odd counts', () => {
    expect(progressPercent({ ...fresh, maxClicks: 0, visitorCount: 0 })).toBe(0);
    expect(progressPercent({ ...fresh, maxClicks: 5, visitorCount: 9 })).toBe(100);
  });
});

describe('fillPercent', () => {
  const of = (visitorCount: number, maxClicks: number): number =>
    fillPercent({ ...fresh, visitorCount, maxClicks, maxed: visitorCount >= maxClicks });

  it('draws nothing before the first click', () => {
    expect(fillPercent(null)).toBe(0);
    expect(of(0, 10)).toBe(0);
    expect(of(0, 0)).toBe(0);
  });

  it('gives the first click a head start, then even steps to exactly 100', () => {
    expect([1, 2, 3, 5, 9, 10].map((n) => of(n, 10))).toEqual([19, 28, 37, 55, 91, 100]);
    expect([1, 2, 3].map((n) => of(n, 3))).toEqual([40, 70, 100]);
    expect(of(1, 1)).toBe(100);
  });

  it('never overshoots', () => {
    expect(of(12, 10)).toBe(100);
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
