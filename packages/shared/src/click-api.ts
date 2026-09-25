/** Shared shape returned by both GET /state and POST /click. */
export interface ClickCounts {
  totalCount: number;
  maxClicks: number;
  visitorCount: number;
  visitorRemaining: number;
  maxed: boolean;
}

/**
 * Query params for GET /v1/buttons/:publicKey/state.
 *
 * There is no visitor field: the server derives visitor identity itself, from
 * request properties the client cannot choose. A client-supplied id would be
 * resettable, and a resettable id cannot enforce a per-visitor cap.
 */
export interface StateQuery {
  item: string;
}

/** Body for POST /v1/buttons/:publicKey/click. See `StateQuery` on visitor identity. */
export interface ClickRequest {
  item: string;
}

export type StateResponse = ClickCounts;
export type ClickResponse = ClickCounts;

/** One row of GET /v1/buttons/:id/items. */
export interface ItemSummary {
  itemKey: string;
  totalCount: number;
  updatedAt: string;
}

/**
 * How GET /v1/buttons/:id/items orders its rows: most recently updated first
 * (the default), or highest total first. Ties go by key either way.
 */
export type ItemsSort = 'updated' | 'total';

export interface ItemsPage {
  items: ItemSummary[];
  nextCursor: string | null;
}

/**
 * POST /v1/buttons/:publicKey/reset (the landing-page demo button only): how
 * many of the caller's per-item counters were cleared, and how many clicks
 * that removed from the totals.
 */
export interface ResetResponse {
  resetItems: number;
  removedClicks: number;
}
