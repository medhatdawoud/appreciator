import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOMParser } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SvgGenError, generate, normalizeSvgSource, resolveColors } from '../../src/generate.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

function fixture(name: string): string {
  return join(FIXTURES_DIR, name);
}

async function readFixture(name: string): Promise<string> {
  return readFile(fixture(name), 'utf8');
}

function assertWellFormed(svg: string): void {
  expect(() => new DOMParser().parseFromString(svg, 'image/svg+xml')).not.toThrow();
}

describe('normalizeSvgSource', () => {
  it('normalizes a simple single-path outline icon', async () => {
    const source = await readFixture('simple-star.svg');
    const output = normalizeSvgSource(source);

    assertWellFormed(output);
    expect(output).toContain('viewBox="0 0 24 24"');
    expect(output).toContain('--appr-fill');
    expect(output).toContain('--appr-stroke');
    // The root's hardcoded fill/stroke presentation attributes are gone.
    expect(output).not.toMatch(/<svg[^>]*\bfill="none"/);
    expect(output).not.toMatch(/<svg[^>]*\bstroke="currentColor"/);
  });

  it('strips a hardcoded fill from a child element rather than leaving it to clash', async () => {
    const source = await readFixture('icon-with-child-fill.svg');
    const output = normalizeSvgSource(source);

    assertWellFormed(output);
    expect(output).toContain('viewBox="0 0 24 24"');
    // Root now carries the CSS variables the whole icon inherits from.
    expect(output).toMatch(/<svg[^>]*style="[^"]*--appr-fill[^"]*--appr-stroke[^"]*"/);
    // Neither child path's hardcoded color survives.
    expect(output).not.toContain('#1f2937');
    expect(output).not.toContain('#f59e0b');
    // ids referenced elsewhere are preserved untouched.
    expect(output).toContain('id="body"');
    expect(output).toContain('id="highlight"');
  });

  it('leaves a url() paint-server reference (gradient) alone', async () => {
    const source = await readFixture('icon-with-gradient.svg');
    const output = normalizeSvgSource(source);

    assertWellFormed(output);
    expect(output).toContain('id="grad"');
    expect(output).toContain('fill="url(#grad)"');
  });

  it('throws a clear SvgGenError for malformed XML instead of crashing or guessing', async () => {
    const source = await readFixture('malformed.svg');
    expect(() => normalizeSvgSource(source, 'malformed.svg')).toThrow(SvgGenError);
    expect(() => normalizeSvgSource(source, 'malformed.svg')).toThrow(/not well-formed/);
  });

  it('throws a clear SvgGenError when the root element is not <svg>', async () => {
    const source = await readFixture('not-svg.svg');
    expect(() => normalizeSvgSource(source, 'not-svg.svg')).toThrow(SvgGenError);
    expect(() => normalizeSvgSource(source, 'not-svg.svg')).toThrow(
      /must have <svg> as its root element/,
    );
  });
});

describe('resolveColors', () => {
  it('fills in defaults for flags that were omitted', () => {
    const colors = resolveColors({ clicked: '#ff0000' });
    expect(colors.clicked).toBe('#ff0000');
    expect(colors.default).toBeTruthy();
    expect(colors.hover).toBeTruthy();
    expect(colors.full).toBeTruthy();
  });

  it('rejects a color that is not a hex/keyword/rgb() value', () => {
    expect(() => resolveColors({ default: 'not a color; </style>' })).toThrow(SvgGenError);
  });
});

describe('generate', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'svg-gen-test-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('writes icon.svg and colors.json matching ButtonColors', async () => {
    const result = await generate({
      inputPath: fixture('simple-star.svg'),
      outDir,
      colors: { clicked: '#123456' },
    });

    expect(result.iconPath).toBe(join(outDir, 'icon.svg'));
    expect(result.colorsPath).toBe(join(outDir, 'colors.json'));

    const iconOnDisk = await readFile(result.iconPath, 'utf8');
    assertWellFormed(iconOnDisk);
    expect(iconOnDisk).toContain('--appr-fill');

    const colorsOnDisk = JSON.parse(await readFile(result.colorsPath, 'utf8'));
    expect(colorsOnDisk).toEqual({
      default: result.colors.default,
      hover: result.colors.hover,
      clicked: '#123456',
      full: result.colors.full,
    });
  });
});
