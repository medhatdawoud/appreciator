-- Per-state icons, { default, hover, clicked, full }, each a full SVG document.
-- NULL means the button renders its single svg_source recoloured per state.
ALTER TABLE buttons ADD COLUMN svg_sources JSON NULL
