import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const API_PORT = 3100;
export const PAGE_PORT = 4173;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

/** Written by the e2e server once it has set everything up; read by the specs. */
export const FIXTURE_PATH = join(tmpdir(), 'appreciator-e2e-fixture.json');

export interface SessionFixture {
  /** Name and value of the dashboard session cookie for the seeded account. */
  cookieName: string;
  cookieValue: string;
  /** The seeded account's GitHub login, as the dashboard shows it. */
  login: string;
}

export interface E2eFixture {
  api: string;
  /** A button on the `e2e` tenant, allowed on the example page's origin. */
  publicKey: string;
  /** A second button on the same tenant, drawn with four per-state SVGs; same `maxClicks`. */
  explicitKey: string;
  /** A raw SVG with a hard-coded black fill and no colour variables, painted with `colors`. */
  rawKey: string;
  /** The same raw SVG with `keepIconColors`: it stays black. */
  ownKey: string;
  /** The raw SVG painted with `colors`, with a ring drawn around it. */
  ringKey: string;
  /** The example icon, bursting as dashes instead of icon copies. */
  dashKey: string;
  /** The example icon, with no burst at all. */
  quietKey: string;
  maxClicks: number;
  colors: Record<'default' | 'hover' | 'clicked' | 'full', string>;
  /** Name of the tenant that owns `publicKey`, as the leaderboard lists it. */
  siteName: string;
  /** Public key of the landing page's demo button. */
  demoKey: string;
  /**
   * A signed-in dashboard account. Minted by the harness with the server's
   * own session code, so the specs never take the GitHub OAuth hop.
   */
  session: SessionFixture;
}
