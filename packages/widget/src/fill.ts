/**
 * Where the drawing sits inside its icon box, as percentages of the box
 * height: the empty space above it and below it.
 *
 * The fill layer is clipped on the box, but icons rarely touch its edges (the
 * heart's tip and padding take the bottom fifth), so measuring progress on the
 * box makes early clicks colour empty space. Mapping progress onto the drawing
 * instead makes 19% mean 19% of the drawing.
 */
export interface DrawingBounds {
  top: number;
  bottom: number;
}

export interface DrawingGeometry {
  /** The SVG's viewBox, in user units. */
  viewBox: { y: number; width: number; height: number };
  /** The rendered size of the SVG element, in CSS pixels. */
  box: { width: number; height: number };
  /** The bounding box of the drawing's geometry, in user units (strokes excluded). */
  bbox: { y: number; height: number };
  /** Stroke width in user units; half of it extends past the geometry. */
  strokeWidth: number;
}

/**
 * Converts measured geometry into box-relative padding, assuming the default
 * `preserveAspectRatio` (centred, letterboxed). Null when anything is
 * unmeasured or degenerate, in which case the caller fills the whole box.
 */
export function drawingBounds(geometry: DrawingGeometry): DrawingBounds | null {
  const { viewBox, box, bbox, strokeWidth } = geometry;
  if (viewBox.width <= 0 || viewBox.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  if (!(bbox.height > 0)) return null;

  const scale = Math.min(box.width / viewBox.width, box.height / viewBox.height);
  const offsetY = (box.height - viewBox.height * scale) / 2;
  const halfStroke = Math.max(0, strokeWidth) / 2;
  const topUser = Math.max(viewBox.y, bbox.y - halfStroke);
  const bottomUser = Math.min(viewBox.y + viewBox.height, bbox.y + bbox.height + halfStroke);
  if (bottomUser <= topUser) return null;

  const topPx = offsetY + (topUser - viewBox.y) * scale;
  const bottomPx = offsetY + (bottomUser - viewBox.y) * scale;
  return {
    top: round2((topPx / box.height) * 100),
    bottom: round2(100 - (bottomPx / box.height) * 100),
  };
}

/**
 * The fill layer's top inset, in percent of the box, for a fill of
 * `fillPercent` (0–100) of the drawing. Nothing shows at 0, and 100 reveals
 * exactly the drawing.
 */
export function clipInsetTop(fillPercent: number, bounds: DrawingBounds | null): number {
  if (fillPercent <= 0) return 100;
  const { top, bottom } = bounds ?? { top: 0, bottom: 0 };
  const content = 100 - top - bottom;
  return round2(top + content * (1 - Math.min(100, fillPercent) / 100));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
