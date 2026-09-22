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
