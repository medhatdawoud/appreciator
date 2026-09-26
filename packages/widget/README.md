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

| Attribute       | Required | Description                                                             |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `data-key`      | yes      | The button's public key.                                                |
| `data-item`     | no       | Explicit counter id. Defaults to the page URL (normalised server-side). |
| `data-label`    | no       | Accessible name prefix. Defaults to `Appreciate`.                       |
| `data-count`    | no       | Where the count sits: `right` (default), `left`, `top` or `bottom`.     |
| `data-readonly` | no       | Show the count without taking clicks (see below).                       |
| `data-sound`    | no       | `off` silences the button's click sounds on this page.                  |
| `data-target`   | no       | CSS selector of the element to render into, instead of after the tag.   |
| `data-api`      | no       | Server base URL. Defaults to where the bundle was loaded from.          |

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

The element takes `data-key`, `data-item`, `data-label`, `data-count` and
`data-readonly` as above, plus `data-api`, which is required when the bundle
was **not** loaded from the appreciator server (a bundler build, or a copy
hosted elsewhere). `mount()` takes `readonly: true` for the same.

### Read-only

`data-readonly` (any value but `false`) shows the button as it is, the total
and this visitor's fill, but takes no clicks: nothing is sent, and there is no
pulse, burst, thank-you message or hover of its own. Use it where the count is
for reading, such as a list of posts that each link to the page with the real
button.

It is not a control then, so it stays out of the way of whatever holds it:
the element takes no pointer events at all (`pointer-events: none`), so the
pointer goes straight to what is under or around it for clicks, hover and the
cursor, and a click on the count inside a post card's link follows the
link. It is out of the tab order, and the element presents itself as an image
named with the count ("Appreciate, 12 total"), which inside a link becomes
part of the link's name; a role or label the page set on the element is left
alone. Adding or removing it takes effect at once, without reloading
anything.

### States

The element reflects `data-state` on itself so the host page can style around it:

- `default` — clickable.
- `clicked` — held for 350 ms after each click; the icon pulses and its filled part takes the `clicked` colour, and the count rolls up to its new number: the old one slides up and out while the new one slides in from below, clipped to the count's line (about 0.3 s). Only a counted click rolls it; loading, server corrections, a reset and clicks on a spent button change it without animating. Reduced motion swaps it instantly.
- `full` — this visitor has used their allowance; the icon is fully coloured, and the count takes the `full` colour too.
  The button stays clickable: every further click counts nothing and replays
  the burst (below). It carries `aria-disabled="true"` and an accessible name
  ending in "all used", so assistive tech still reports it as finished.

`hover` is pure CSS: the icon grows slightly and the unfilled part takes the
`hover` colour.

It also reflects `data-progress`, the share of this visitor's allowance
already spent as a whole percentage (`0`–`100`), counting clicks still in
flight. The drawn fill, `--appr-progress` on the element, gives the first
click a 10-point head start and spreads the rest evenly, so a 10-click button
fills to 19%, 28%, 37% … 100%, and a first click is visible even on icons
with an empty bottom edge. Each rise eases in over 0.8 s (instant with
`prefers-reduced-motion`).

And `data-own-colors` when the button keeps its icon's own colours
(`keepIconColors`). Without it, every shape of a single icon is painted with
the colour variables below, overriding the colours in the file, so an SVG
uploaded as-is follows the button's colours; definitions (masks, clip paths,
gradients, symbols) are left alone.

And `data-ring` when the button draws a circle around its icon (`iconRing`):
a 1px round border on `::part(icon)`, set off from the icon by 0.3 of its
size, in the `default` colour at rest, `hover` under the pointer, `clicked`
during the pulse and `full` once full, each overridable with the same
`--appreciator-*` variables. The burst starts and ends further out so it
clears the ring.

And `data-icons`, which says how the icon is drawn:

- `single` — one SVG drawn twice inside `::part(icon)`: a dimmed silhouette
  (`svg[data-layer="base"]`, painted with the `default` colour, or run through
  `grayscale()` when it keeps its own colours so it still starts gray), and a
  coloured copy (`svg[data-layer="fill"]`, painted with `full`)
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

**Burst.** Every click, counted or not, throws five small full-colour copies
of the icon out from around it, to the corners of a pentagon with one corner
pointing straight away from the count, so the count sits in the widest gap
between copies on whichever side `data-count` puts it. Each copy appears just
outside the icon's edge and flies further out at a constant size as it fades,
over about 0.5 s (`data-burst` is set on the element meanwhile, and
`appreciator:burst` fires). A click on a spent button still bursts but counts
nothing. A button that loads does not burst on its own. The copies live in
`::part(burst)`; `prefers-reduced-motion` hides them.

**Sound.** Unless the button's `clickSound` is off, or the page sets
`data-sound="off"`, each counted click plays a soft pop, a tenth of a second
long, that climbs a little in pitch as the allowance fills; the click that
fills the button plays a two-note chime instead, and a click on a spent button
a quieter, lower pop. The sounds are synthesised with Web Audio, so there is
no file to fetch and nothing for a strict CSP to refuse, and they start only
from a click, as browsers require. Read-only buttons are silent, and where Web
Audio is missing nothing plays.

**Thank-you message.** On the click that uses up the visitor's allowance,
and on every click after it, the button's `thanksMessage` fades in under it (above it when `data-count` is
`bottom`) and fades out 1.5 s later (`THANKS_MS`); `data-thanked` is set
meanwhile. It is 80% of the page's text size and wraps a typical message onto
two lines, and it sits over whatever follows rather than pushing it down, so
nothing on the page moves. Next to the edge of the window it slides back into
view. Its text is filled in only as it appears, in a `role="status"` region,
so screen readers announce it. Each click restarts its 1.5 s. A visitor who
comes back already spent sees it only once they click, and an empty message
shows nothing. It lives in `::part(thanks)`.

If loading fails the element gets `data-error` (e.g. `network_error`,
`origin_not_allowed`, `invalid_svg`, `missing_attributes`) and stays disabled.

### Theming

Colours come from the button's server-side config. A page can override them,
and the size, with CSS custom properties on the element. `--appreciator-size`
sizes the whole button: the count is 65% of it, a step below the icon, and
the gap half of it (a quarter when stacked), or with a ring three quarters (a
half when stacked). With no size set the icon is `1.5em`, so the count is
about 0.98× the page's font. Size the count on its own with
`::part(count) { font-size: … }`:

```css
appreciator-button {
  --appreciator-size: 2rem;
  --appreciator-default: #9ca3af; /* the unfilled silhouette */
  --appreciator-hover: #6b7280; /* the silhouette while hovered */
  --appreciator-clicked: orange; /* the filled part during the pulse */
  --appreciator-full: gold; /* the filled part */
}
```

The inner button, icon, count, burst and thank-you message are exposed as
`::part(button)`, `::part(icon)`, `::part(count)`, `::part(burst)` and
`::part(thanks)`. For example, `::part(thanks) { position: static; }` puts
the message in the page's flow instead of over it.

A button configured with four SVGs draws each state with its own complete
document, so the colour variables have nothing to recolour unless those
documents reference them themselves; `--appreciator-size` still sizes every
icon. Package the four files with `svg-gen generate --explicit`.

### Events

All bubble and cross the shadow boundary, and all are optional: the button
works the same whether anything listens.

| Event                | Fires                                                                   | `event.detail`                         |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| `appreciator:ready`  | Once the button has loaded and shows its count.                         | counts                                 |
| `appreciator:burst`  | On every click, counted or not, as the burst plays.                     | counts, as shown right after the click |
| `appreciator:change` | When the server confirms a counted click.                               | counts                                 |
| `appreciator:maxed`  | Once, when the click that uses up the visitor's allowance is confirmed. | counts                                 |
| `appreciator:error`  | When loading or a click fails.                                          | `{ code, message }`                    |

The counts are `{ totalCount, maxClicks, visitorCount, visitorRemaining, maxed }`.
`event.target` is the button, so one listener on `document` hears every button:

```js
document.addEventListener('appreciator:burst', (event) => {
  console.log('clicked', event.target, event.detail.totalCount);
});
```

### Methods

- `refresh()` re-reads the button's config and counts from the server, without
  painting the cached counts first, and resolves once loaded. Use it when the
  page knows the counts changed, as the landing page does after resetting the
  demo.
- `whenReady()` and `whenIdle()` resolve once loaded and once every accepted
  click has been sent.
- `preview(config)` runs the button from a config alone (the shape
  `GET /v1/buttons/:publicKey/config` serves), with no key, no requests and
  nothing stored. Counts start at zero and each click settles locally the way
  the server would, so the fill, pulse, count, burst and full state play as
  they do live. Calling it again starts over. The dashboard's "Try it" uses
  it.

The bundle also exports `stateIcon(config, state)`, which returns the icon as
it looks in one state (`default`, `hover`, `clicked`, `full`) as a standalone
SVG element, painted as the button paints it. The dashboard draws its colour
table with it (`Appreciator.stateIcon` from the script tag).

## How it behaves

On connect it draws the last known icon and counts from `localStorage` for an
instant render (the button stays disabled until the server answers), then
fetches the button config and the current counts in parallel; the server is
the source of truth and overwrites both caches.

Loads survive a bad moment. If the server is throttling (429), unreachable or
failing (5xx), each load is retried up to three times, waiting what the
server's `Retry-After` asks (0.5–10 s) or else 1 s, 2 s, 4 s with jitter. The
icon is drawn as soon as a config is known, cached or fresh, so a load that
still fails leaves the icon in place with `data-error` set (`rate_limited`,
`network_error`, …) and the button disabled, never an empty space with only a
count. Clicks are not retried, so nothing is ever counted twice. A page on an
origin outside the button's allowlist looks offline to the widget (the
browser blocks the answer), so it reports `network_error` after its retries,
about 7 s.

Each click is shown
immediately and sent one at a time, so the server's answer to each is
authoritative and rapid clicks stay consistent. When the server reports the
visitor is maxed, the button locks into `full`.

A button that counts the page it is on (no `data-item`) follows single-page
app navigation: when the router changes the address without loading a page,
and the change names a different counter (a new path, or any change under
`full` URL counting), the button reloads for the new page. It listens through
the Navigation API, or wraps `history.pushState`/`replaceState` and listens
for `popstate` where that API is missing. A button with `data-item` reloads
when that attribute changes instead.

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
