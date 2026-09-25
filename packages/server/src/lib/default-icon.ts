import type { ButtonColors } from '@appreciator/shared';

/**
 * The icon a button gets when it is created without `svgSource`/`colors`.
 *
 * It is the Feather "heart" (MIT), already normalised the way `svg-gen`
 * would: no hardcoded paint, and `fill`/`stroke` pointed at the CSS variables
 * the widget sets per state. Kept as a string constant rather than a file so
 * the built server carries it without any extra asset copying.
 */
/** The heart's outline, in a 24×24 box; the site badge draws it too. */
export const HEART_PATH =
  'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';

export const DEFAULT_SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" ' +
  'style="fill: var(--appr-fill, none); stroke: var(--appr-stroke, currentColor);">' +
  `<path d="${HEART_PATH}"/>` +
  '</svg>';

export const DEFAULT_COLORS: ButtonColors = {
  default: '#6b7280',
  hover: '#374151',
  clicked: '#f43f5e',
  full: '#e11d48',
};
