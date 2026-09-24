import type { ButtonPublicConfig, ButtonState } from '@appreciator/shared';

import { PAINT_EXEMPT, REST_OPACITY } from './element.js';
import { parseSafeSvg } from './sanitize-svg.js';

/** What `stateIcon` needs from a button's config. */
export type StateIconConfig = Pick<
  ButtonPublicConfig,
  'svgSource' | 'svgSources' | 'colors' | 'keepIconColors'
>;

/**
 * The button's icon as it looks in one `state`, as a standalone inert SVG, so
 * a settings page can show it beside that state's colour.
 *
 * It is painted the way the button paints it:
 * - With four drawings (`svgSources`), that state's drawing, as it is.
 * - With one icon, the state's colour on every drawn element, unless the
 *   icon keeps its own colours. `default` and `hover` show the unfilled icon,
 *   so they are dimmed like it, and with its own colours also turned gray.
 *
 * Paint goes through the CSSOM, which a strict `style-src` allows. Null if
 * the icon cannot be parsed.
 */
export function stateIcon(config: StateIconConfig, state: ButtonState): Element | null {
  if (config.svgSources !== undefined) return parseSafeSvg(config.svgSources[state]);

  const svg = parseSafeSvg(config.svgSource);
  if (svg === null) return null;
  const color = config.colors[state];
  const style = (svg as SVGElement).style;
  // Icons prepared with svg-gen take their colours from these.
  style.setProperty('--appr-fill', color);
  style.setProperty('--appr-stroke', color);
  if (!config.keepIconColors) {
    for (const element of svg.querySelectorAll<SVGElement>('*')) {
      if (element.matches(PAINT_EXEMPT)) continue;
      element.style.setProperty('fill', color, 'important');
      element.style.setProperty('stroke', color, 'important');
    }
  }
  if (state === 'default' || state === 'hover') {
    style.setProperty('opacity', String(REST_OPACITY[state]));
    if (config.keepIconColors) style.setProperty('filter', 'grayscale(1)');
  }
  return svg;
}
