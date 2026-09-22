import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const API_PORT = 3100;
export const PAGE_PORT = 4173;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

/** Written by the e2e server once it has registered the test button; read by the specs. */
export const FIXTURE_PATH = join(tmpdir(), 'appreciator-e2e-button.json');

export interface ButtonFixture {
  api: string;
  publicKey: string;
  maxClicks: number;
  colors: Record<'default' | 'hover' | 'clicked' | 'full', string>;
}
