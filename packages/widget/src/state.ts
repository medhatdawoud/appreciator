import type { ClickCounts } from '@appreciator/shared';

/** The JS-driven visual states. `hover` is handled purely in CSS. */
export type VisualState = 'default' | 'clicked' | 'full';

export function visualState(counts: ClickCounts | null, pulsing: boolean): VisualState {
  if (pulsing) return 'clicked';
  return counts?.maxed ? 'full' : 'default';
}

export function canClick(counts: ClickCounts | null): boolean {
  return counts !== null && !counts.maxed;
}

/** How much of this visitor's allowance is spent, as a whole percentage. */
export function progressPercent(counts: ClickCounts | null): number {
  if (counts === null || counts.maxClicks <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((100 * counts.visitorCount) / counts.maxClicks)));
}

/**
 * Extra fill granted by the first click. A tenth of an icon's box is often
 * just its empty bottom edge, so without it a first click on a 10-click
 * button barely shows.
 */
export const FIRST_CLICK_BOOST = 10;

/**
 * How much of the icon to colour, as a whole percentage: nothing before the
 * first click, then `FIRST_CLICK_BOOST` plus the rest spread evenly over the
 * allowance, so the last click still lands exactly on 100.
 */
export function fillPercent(counts: ClickCounts | null): number {
  if (counts === null || counts.maxClicks <= 0 || counts.visitorCount <= 0) return 0;
  const spent = Math.min(1, counts.visitorCount / counts.maxClicks);
  return Math.round(FIRST_CLICK_BOOST + (100 - FIRST_CLICK_BOOST) * spent);
}

/** The counts as they will look once one more click is accepted by the server. */
export function optimisticClick(counts: ClickCounts): ClickCounts {
  if (counts.maxed) return counts;
  const visitorCount = counts.visitorCount + 1;
  const visitorRemaining = Math.max(counts.maxClicks - visitorCount, 0);
  return {
    ...counts,
    totalCount: counts.totalCount + 1,
    visitorCount,
    visitorRemaining,
    maxed: visitorRemaining === 0,
  };
}
