import { describe, expect, it } from 'vitest';

import { stateIcon, type StateIconConfig } from '../../src/index.js';
import { sampleSvgSources } from './fake-server.js';

const COLORS = { default: '#111111', hover: '#222222', clicked: '#333333', full: '#444444' };

/** A black upload with a gradient definition, as a design tool exports it. */
const RAW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
  '<g><path fill="#000000" d="M12 2 22 21H2z"/><circle r="2" stroke="#000"/></g></svg>';

function config(overrides: Partial<StateIconConfig> = {}): StateIconConfig {
  return { svgSource: RAW_SVG, colors: COLORS, keepIconColors: false, ...overrides };
}

function drawn(svg: Element): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('path, circle, g'));
}

describe('stateIcon', () => {
  it("paints every drawn element with the state's colour", () => {
    for (const state of ['default', 'hover', 'clicked', 'full'] as const) {
      const svg = stateIcon(config(), state);
      if (svg === null) throw new Error('expected an icon');

      for (const element of drawn(svg)) {
        expect(element.style.getPropertyValue('fill')).toBe(COLORS[state]);
        expect(element.style.getPropertyPriority('fill')).toBe('important');
        expect(element.style.getPropertyValue('stroke')).toBe(COLORS[state]);
      }
      expect((svg as SVGElement).style.getPropertyValue('--appr-fill')).toBe(COLORS[state]);
    }
  });

  it('leaves definitions alone', () => {
    const svg = stateIcon(config(), 'full');

    const stop = svg?.querySelector<SVGElement>('stop');
    expect(stop?.style.getPropertyValue('fill')).toBe('');
  });

  it('dims the unfilled states like the button does, without draining their colour', () => {
    const rest = stateIcon(config(), 'default') as SVGElement;
    const hover = stateIcon(config(), 'hover') as SVGElement;
    const full = stateIcon(config(), 'full') as SVGElement;

    expect(rest.style.getPropertyValue('opacity')).toBe('0.45');
    expect(hover.style.getPropertyValue('opacity')).toBe('0.6');
    expect(full.style.getPropertyValue('opacity')).toBe('');
    expect(rest.style.getPropertyValue('filter')).toBe('');
  });

  it('keeps the artwork when the icon keeps its own colours, graying the unfilled states', () => {
    const rest = stateIcon(config({ keepIconColors: true }), 'default') as SVGElement;
    const full = stateIcon(config({ keepIconColors: true }), 'full') as SVGElement;

    for (const svg of [rest, full]) {
      for (const element of drawn(svg)) expect(element.style.getPropertyValue('fill')).toBe('');
    }
    expect(rest.style.getPropertyValue('filter')).toBe('grayscale(1)');
    expect(full.style.getPropertyValue('filter')).toBe('');
  });

  it("shows a four-SVG button's own drawing for each state, as it is", () => {
    const svgSources = sampleSvgSources();

    const hover = stateIcon(config({ svgSources }), 'hover');

    expect(hover?.querySelector('circle')?.getAttribute('r')).toBe('9');
    expect((hover as SVGElement).style.getPropertyValue('opacity')).toBe('');
  });

  it('is null for an icon that is not an SVG', () => {
    expect(stateIcon(config({ svgSource: '<div/>' }), 'default')).toBeNull();
  });
});
