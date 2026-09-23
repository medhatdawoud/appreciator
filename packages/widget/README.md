# @appreciator/widget

The embeddable `<appreciator-button>` web component. Framework-agnostic: it
works from a plain `<script>` tag or as an ES module, and isolates its styling
in a shadow root. It needs no `'unsafe-inline'` from the host page's
Content-Security-Policy: its own styles are a constructed stylesheet, and an
icon's `style` attributes are applied through the CSSOM.

## Embedding

The server generates this snippet when a button is created:

```html
<script src="https://appreciator.example.com/widget.js" data-key="pk_..." async></script>
```

That is the whole embed. The bundle reads its own `src` to learn which server
to talk to, and because the tag carries `data-key` it renders a button right
after itself. Options are `data-*` attributes on the tag:

| Attribute     | Required | Description                                                             |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `data-key`    | yes      | The button's public key.                                                |
| `data-item`   | no       | Explicit counter id. Defaults to the page URL (normalised server-side). |
| `data-label`  | no       | Accessible name prefix. Defaults to `Appreciate`.                       |
| `data-count`  | no       | Where the count sits: `right` (default), `left`, `top` or `bottom`.     |
| `data-target` | no       | CSS selector of the element to render into, instead of after the tag.   |
| `data-api`    | no       | Server base URL. Defaults to where the bundle was loaded from.          |

A tag in `<head>` renders into `<body>`; a `data-target` that does not exist
yet is looked up once the document has been parsed.

### The element

A tag without `data-key` only registers the element, for pages that want to
place buttons themselves — several on one page, or inside a template:

```html
<script src="https://appreciator.example.com/widget.js" async></script>
...
<appreciator-button data-key="pk_..." data-item="post-1"></appreciator-button>
<appreciator-button data-key="pk_..." data-item="post-2"></appreciator-button>
```

Or from a bundler:

```ts
import { mount } from '@appreciator/widget';

mount(document.querySelector('#appreciate'), {
  api: 'https://appreciator.example.com',
  key: 'pk_...',
});
```

Importing the module registers the element; `mount()` is a convenience for
creating one programmatically.

The element takes `data-key`, `data-item`, `data-label` and `data-count` as above, plus
`data-api`, which is required when the bundle was **not** loaded from the
appreciator server (a bundler build, or a copy hosted elsewhere).

### States

The element reflects `data-state` on itself so the host page can style around it:

- `default` — clickable.
- `clicked` — held for 350 ms after each click; the icon pulses and its filled part takes the `clicked` colour, and the count pops (grows to 1.25× and flashes the `clicked` colour). Clicks on a spent button don't pop the count, since nothing was counted.
- `full` — this visitor has used their allowance; the icon is fully coloured.
  The button stays clickable: every further click counts nothing and replays
  the burst (below). It carries `aria-disabled="true"` and an accessible name
  ending in "all used", so assistive tech still reports it as finished.

`hover` is pure CSS: the icon grows slightly and the gray part takes the
`hover` colour.

It also reflects `data-progress`, the share of this visitor's allowance
already spent as a whole percentage (`0`–`100`), counting clicks still in
flight. The drawn fill, `--appr-progress` on the element, gives the first
click a 10-point head start and spreads the rest evenly, so a 10-click button
fills to 19%, 28%, 37% … 100%, and a first click is visible even on icons
with an empty bottom edge. Each rise eases in over 0.8 s (instant with
`prefers-reduced-motion`).

And `data-icons`, which says how the icon is drawn:

- `single` — one SVG drawn twice inside `::part(icon)`: a gray silhouette
  (`svg[data-layer="base"]`, painted with the `default` colour and run through
  `grayscale()`, so even an icon that ignores the colour variables starts
  gray), and a coloured copy (`svg[data-layer="fill"]`, painted with `full`)
  revealed from the bottom up to `--appr-progress`. The reveal is mapped onto
  the drawing's measured extent (`getBBox()` plus the stroke, within the
  viewBox), not the whole box, so padding above or below an icon never
  swallows progress. Until the icon is laid out (for example inside a hidden
  tab) it falls back to the whole box and measures again on the next render.
- `states` — the button has four SVGs (`svgSources`), one per state, each
  tagged `data-for="default|hover|clicked|full"` inside `::part(icon)`. Exactly
  one is shown at a time: `hover` replaces `default` while the pointer is over
  an enabled button, and `clicked` and `full` follow `data-state`. Hover is
  still pure CSS. These buttons do not show progress.

**Burst.** The click that spends the allowance, and every click after it,
throws six small full-colour copies of the icon out of the button, 60° apart,
for about 0.7 s (`data-burst` is set on the element meanwhile, and
`appreciator:burst` fires). A button that loads already spent does not burst
on its own. The copies live in `::part(burst)`; `prefers-reduced-motion`
hides them.

If loading fails the element gets `data-error` (e.g. `network_error`,
`origin_not_allowed`, `invalid_svg`, `missing_attributes`) and stays disabled.

### Theming

Colours come from the button's server-side config. A page can override them,
and the icon size, with CSS custom properties on the element:

```css
appreciator-button {
  --appreciator-size: 2rem;
  --appreciator-default: #9ca3af; /* the gray silhouette */
  --appreciator-hover: #6b7280; /* the silhouette while hovered */
  --appreciator-clicked: orange; /* the filled part during the pulse */
  --appreciator-full: gold; /* the filled part */
}
```

The inner button, icon, count and burst are exposed as `::part(button)`,
`::part(icon)`, `::part(count)` and `::part(burst)`.

A button configured with four SVGs draws each state with its own complete
document, so the colour variables have nothing to recolour unless those
documents reference them themselves; `--appreciator-size` still sizes every
icon. Package the four files with `svg-gen generate --explicit`.

### Events

All bubble and cross the shadow boundary, with the counts (or an error) in `detail`:

`appreciator:ready`, `appreciator:change`, `appreciator:maxed`, `appreciator:burst`,
`appreciator:error`.

### Methods

- `refresh()` re-reads the button's config and counts from the server, without
  painting the cached counts first, and resolves once loaded. Use it when the
  page knows the counts changed, as the landing page does after resetting the
  demo.
- `whenReady()` and `whenIdle()` resolve once loaded and once every accepted
  click has been sent.

## How it behaves

On connect it reads any cached counts from `localStorage` for an instant
render, then fetches the button config and the current counts in parallel; the
server is the source of truth and overwrites the cache. Each click is shown
immediately and sent one at a time, so the server's answer to each is
authoritative and rapid clicks stay consistent. When the server reports the
visitor is maxed, the button locks into `full`.

The per-visitor cap is enforced server-side from the request's IP address and
user agent, so clearing `localStorage` does not grant a fresh allowance. See
the server README for what that does and does not guarantee.

## Tests

```bash
npm run test:unit -w @appreciator/widget    # vitest + jsdom, fake fetch
npm run test:e2e -w @appreciator/widget     # Playwright against the real server + MySQL
```

The e2e run needs `docker compose up -d mysql` and a one-time
`npx playwright install chromium`. It builds the bundle, migrates a dedicated
`appreciator_e2e` schema, creates a tenant through the real CLI, registers a
button with the example icon, and drives `examples/plain-html` in Chromium on a
separate origin so the origin allowlist is exercised for real.
