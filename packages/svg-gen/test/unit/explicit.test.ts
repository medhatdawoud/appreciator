import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateExplicit } from '../../src/explicit.js';
import { SvgGenError } from '../../src/generate.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

function fixture(name: string): string {
  return join(FIXTURES_DIR, name);
}

describe('generateExplicit', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'svg-gen-explicit-test-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('copies all 4 state SVGs through untouched and writes a manifest', async () => {
    const result = await generateExplicit({
      inputs: {
        default: fixture('explicit-default.svg'),
        hover: fixture('explicit-hover.svg'),
        clicked: fixture('explicit-clicked.svg'),
        full: fixture('explicit-full.svg'),
      },
      outDir,
    });

    expect(result.files).toEqual({
      default: join(outDir, 'default.svg'),
      hover: join(outDir, 'hover.svg'),
      clicked: join(outDir, 'clicked.svg'),
      full: join(outDir, 'full.svg'),
    });
    expect(result.manifestPath).toBe(join(outDir, 'manifest.json'));
    expect(result.svgSourcesPath).toBe(join(outDir, 'svgSources.json'));

    const [
      defaultOut,
      hoverOut,
      clickedOut,
      fullOut,
      sourceDefault,
      sourceHover,
      sourceClicked,
      sourceFull,
    ] = await Promise.all([
      readFile(result.files.default, 'utf8'),
      readFile(result.files.hover, 'utf8'),
      readFile(result.files.clicked, 'utf8'),
      readFile(result.files.full, 'utf8'),
      readFile(fixture('explicit-default.svg'), 'utf8'),
      readFile(fixture('explicit-hover.svg'), 'utf8'),
      readFile(fixture('explicit-clicked.svg'), 'utf8'),
      readFile(fixture('explicit-full.svg'), 'utf8'),
    ]);

    expect(defaultOut).toBe(sourceDefault);
    expect(fullOut).toBe(sourceFull);
    expect(hoverOut).toContain('#6b7280');
    expect(clickedOut).toContain('#f43f5e');

    const svgSources = JSON.parse(await readFile(result.svgSourcesPath, 'utf8'));
    expect(svgSources).toEqual({
      svgSources: {
        default: sourceDefault,
        hover: sourceHover,
        clicked: sourceClicked,
        full: sourceFull,
      },
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest).toEqual({
      mode: 'explicit',
      states: ['default', 'hover', 'clicked', 'full'],
      files: {
        default: 'default.svg',
        hover: 'hover.svg',
        clicked: 'clicked.svg',
        full: 'full.svg',
      },
    });
  });

  it('rejects a malformed input file with a clear error instead of copying garbage', async () => {
    await expect(
      generateExplicit({
        inputs: {
          default: fixture('malformed.svg'),
          hover: fixture('explicit-hover.svg'),
          clicked: fixture('explicit-clicked.svg'),
          full: fixture('explicit-full.svg'),
        },
        outDir,
      }),
    ).rejects.toThrow(SvgGenError);
  });
});
