/** The four visual states a button icon can render. */
export type ButtonState = 'default' | 'hover' | 'clicked' | 'full';

export type ButtonColors = Record<ButtonState, string>;

/** How a button derives its per-item counter key from the embedding page. */
export type UrlNormalization = 'pathname' | 'full';

/** Persisted configuration for one button, as returned by the management API. */
export interface ButtonConfig {
  id: string;
  publicKey: string;
  maxClicks: number;
  allowedOrigins: string[];
  svgSource: string;
  colors: ButtonColors;
  urlNormalization: UrlNormalization;
  createdAt: string;
}

/** Request body for POST /v1/buttons and PATCH /v1/buttons/:id. */
export interface ButtonConfigInput {
  maxClicks?: number;
  allowedOrigins: string[];
  svgSource: string;
  colors: ButtonColors;
  urlNormalization?: UrlNormalization;
}

export interface CreateButtonResponse {
  buttonId: string;
  publicKey: string;
  embedSnippet: string;
}
