/** The four visual states a button icon can render. */
export type ButtonState = 'default' | 'hover' | 'clicked' | 'full';

export type ButtonColors = Record<ButtonState, string>;

/**
 * One complete SVG document per state, for icons a single recoloured shape
 * cannot express. When a button has these, they win over `svgSource` and
 * `colors`.
 */
export type ButtonSvgSources = Record<ButtonState, string>;

/** How a button derives its per-item counter key from the embedding page. */
export type UrlNormalization = 'pathname' | 'full';

/** Persisted configuration for one button, as returned by the management API. */
export interface ButtonConfig {
  id: string;
  publicKey: string;
  /** Tenant-facing label. Never served to embedding pages. */
  name: string | null;
  maxClicks: number;
  allowedOrigins: string[];
  svgSource: string;
  colors: ButtonColors;
  svgSources: ButtonSvgSources | null;
  urlNormalization: UrlNormalization;
  createdAt: string;
  /** The one-tag embed for this button, the same one `CreateButtonResponse` returns. */
  embedSnippet: string;
}

/**
 * Request body for POST /v1/buttons and PATCH /v1/buttons/:id.
 *
 * Only `allowedOrigins` is required to create a button: the icon and colours
 * default to the server's built-in heart, so a first button is one request.
 */
export interface ButtonConfigInput {
  /** Trimmed; an empty name is stored as no name. */
  name?: string;
  maxClicks?: number;
  allowedOrigins: string[];
  svgSource?: string;
  colors?: ButtonColors;
  /** Mutually exclusive with `svgSource` in one request. */
  svgSources?: ButtonSvgSources;
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
  /** Present only when the button has per-state icons; render these instead of `svgSource`. */
  svgSources?: ButtonSvgSources;
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
