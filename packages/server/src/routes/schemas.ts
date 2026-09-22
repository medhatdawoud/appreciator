/**
 * JSON Schema fragments shared by more than one route module.
 *
 * Colours appear both as management input and in the public config response,
 * and the two must not drift: a pattern that rejects a value on the way in is
 * pointless if the way out would have serialized something else.
 */

/**
 * A CSS colour we are willing to interpolate into an icon: a hex literal, a
 * bare keyword, or an rgb()/rgba() call. Anything else could close out of an
 * attribute in whatever markup the widget builds.
 */
export const COLOR_PATTERN = '^(#[0-9A-Fa-f]{3,8}|[A-Za-z]{1,32}|rgba?\\([0-9.,%\\s]{1,40}\\))$';

export const colorSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: COLOR_PATTERN,
};

export const colorsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['default', 'hover', 'clicked', 'full'],
  properties: {
    default: colorSchema,
    hover: colorSchema,
    clicked: colorSchema,
    full: colorSchema,
  },
};

/**
 * One tenant-supplied SVG document. The schema bounds characters as a cheap
 * first cut; `assertSafeSvg` enforces the real byte cap and content rules.
 */
export const svgSourceSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 65536,
};

/**
 * Per-state icons: all four states or none, so the widget never has to guess
 * what to draw for a state that was left out.
 */
export const svgSourcesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['default', 'hover', 'clicked', 'full'],
  properties: {
    default: svgSourceSchema,
    hover: svgSourceSchema,
    clicked: svgSourceSchema,
    full: svgSourceSchema,
  },
};

/** A button or site id as the database stores it. Checked before any query runs. */
export const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
