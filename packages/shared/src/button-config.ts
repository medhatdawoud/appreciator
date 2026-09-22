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

/**
 * Request body for POST /v1/buttons and PATCH /v1/buttons/:id.
 *
 * Only `allowedOrigins` is required to create a button: the icon and colours
 * default to the server's built-in heart, so a first button is one request.
 */
export interface ButtonConfigInput {
  maxClicks?: number;
  allowedOrigins: string[];
  svgSource?: string;
  colors?: ButtonColors;
  urlNormalization?: UrlNormalization;
}

/**
 * What GET /v1/buttons/:publicKey/config returns: the fields the widget needs
 * to render itself, and nothing else.
 *
 * This is served to any allowed origin, so it deliberately omits `id`,
 * `publicKey`, `allowedOrigins` and anything identifying the owning tenant.
 */
export interface ButtonPublicConfig {
  maxClicks: number;
  svgSource: string;
  colors: ButtonColors;
  urlNormalization: UrlNormalization;
}

export interface CreateButtonResponse {
  buttonId: string;
  publicKey: string;
  embedSnippet: string;
}

/** GET /v1/buttons: every button the authenticated tenant owns, oldest first. */
export interface ButtonListResponse {
  buttons: ButtonConfig[];
}
