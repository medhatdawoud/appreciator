import type { ButtonColors } from './button-config.js';

/** A dashboard user, signed in with GitHub. */
export interface Account {
  id: string;
  login: string;
  avatarUrl: string | null;
}

/**
 * A site in the dashboard. A site is a tenant owned by an account: it has its
 * own management secret and its own buttons.
 */
export interface Site {
  id: string;
  name: string;
  createdAt: string;
  buttonCount: number;
  /** Whether the site is listed on the public "Most appreciated" leaderboard. */
  showOnLeaderboard: boolean;
}

/** PATCH /v1/sites/:id: any of these, at least one. */
export interface UpdateSiteBody {
  /** Trimmed; must keep at least one non-space character. */
  name?: string;
  showOnLeaderboard?: boolean;
}

/** GET /v1/sites: the signed-in account's sites, oldest first. */
export interface SiteListResponse {
  sites: Site[];
}

/**
 * POST /v1/sites. `secret` is the site's management key; only its hash is
 * stored, so this is the one time it can be shown.
 */
export interface CreateSiteResponse {
  site: Site;
  secret: string;
}

/** POST /v1/sites/:id/rotate-key. The previous secret stops working immediately. */
export interface RotateKeyResponse {
  secret: string;
}

/** GET /web/config.json: what the landing page and dashboard need to boot. */
export interface WebConfig {
  apiUrl: string;
  /** Public key of the landing page's demo button, or null when it is disabled. */
  demoKey: string | null;
  signInEnabled: boolean;
  repoUrl: string;
  /** Whether GET /v1/leaderboard is served. */
  leaderboardEnabled: boolean;
  /**
   * The icon and colours a button gets without its own, so the dashboard can
   * preview it. Only the server's copy carries it: the dashboard is served by
   * the server alone, and the GitHub Pages copy has no use for it.
   */
  defaultIcon?: { svgSource: string; colors: ButtonColors };
  /** The thank-you message a new button starts with. Server copy only, as above. */
  defaultThanksMessage?: string;
}

/** One site on the public leaderboard. */
export interface LeaderboardEntry {
  siteName: string;
  /**
   * The site's most-clicked page, as origin and path (no query or fragment),
   * or null when none is usable (only opaque item ids, or only loopback hosts).
   */
  url: string | null;
  buttonCount: number;
  /** Every click on every one of the site's buttons. */
  totalCount: number;
}

/** GET /v1/leaderboard: the top sites by total clicks. */
export interface LeaderboardResponse {
  sites: LeaderboardEntry[];
}
