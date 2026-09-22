import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseSvgDocument } from './generate.js';

const STATES = ['default', 'hover', 'clicked', 'full'] as const;
type ExplicitState = (typeof STATES)[number];

export type ExplicitInputs = Record<ExplicitState, string>;

export interface ExplicitOptions {
  inputs: ExplicitInputs;
  outDir: string;
}

export interface ExplicitResult {
  /** Output path written for each state, keyed the same way as the input. */
  files: Record<ExplicitState, string>;
  manifestPath: string;
}

/**
 * The `--explicit` escape hatch: for icons where CSS-variable recoloring wouldn't look right
 * (multi-color logos, icons that change shape between states), each state gets its own
 * hand-authored SVG. No normalization is applied -- each input is validated as well-formed SVG
 * and copied through byte-for-byte, so the caller's markup (colors, ids, structure) is preserved
 * exactly. A manifest.json records that this button is "explicit" so the consumer knows to swap
 * the whole SVG per state instead of driving `--appr-fill`/`--appr-stroke`.
 */
export async function generateExplicit(options: ExplicitOptions): Promise<ExplicitResult> {
  const { inputs, outDir } = options;

  const sources = {} as Record<ExplicitState, string>;
  for (const state of STATES) {
    const path = inputs[state];
    const source = await readFile(path, 'utf8');
    parseSvgDocument(source, `${state} input (${path})`);
    sources[state] = source;
  }

  await mkdir(outDir, { recursive: true });

  const files = {} as Record<ExplicitState, string>;
  for (const state of STATES) {
    const outPath = join(outDir, `${state}.svg`);
    await writeFile(outPath, sources[state], 'utf8');
    files[state] = outPath;
  }

  const manifest = {
    mode: 'explicit',
    states: STATES,
    files: Object.fromEntries(STATES.map((state) => [state, `${state}.svg`])),
  };
  const manifestPath = join(outDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { files, manifestPath };
}
