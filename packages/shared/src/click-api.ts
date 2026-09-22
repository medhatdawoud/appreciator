/** Shared shape returned by both GET /state and POST /click. */
export interface ClickCounts {
  totalCount: number;
  maxClicks: number;
  visitorCount: number;
  visitorRemaining: number;
  maxed: boolean;
}

/** Query params for GET /v1/buttons/:id/state. */
export interface StateQuery {
  item: string;
  visitor: string;
}

/** Body for POST /v1/buttons/:id/click. */
export interface ClickRequest {
  item: string;
  visitor: string;
}

export type StateResponse = ClickCounts;
export type ClickResponse = ClickCounts;

/** One row of GET /v1/buttons/:id/items. */
export interface ItemSummary {
  itemKey: string;
  totalCount: number;
  updatedAt: string;
}

export interface ItemsPage {
  items: ItemSummary[];
  nextCursor: string | null;
}
