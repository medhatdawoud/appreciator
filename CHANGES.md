# Changes

A running record of the significant changes to this repository, newest first.
Each entry is written so it can seed a PR description.

## 2026-09-26 — A short agent prompt that just adds the tag

- Tried for real, the longer prompt turned a one-line change into research:
  agents curled the instance, looked for ways to test, and weighed options
  that did not apply. The prompt is now about 180 words (was about 540). It
  says the button is a drop-in tag with nothing to install, fetch, inspect
  or test; puts it right after the content in the single-post template, or
  the element where a script tag would not run; asks only for the key where
  it is not known, and which template only if that is unclear; and ends with
  the files changed.
- Allowing the site's origins is the owner's step, so it moves out of the
  prompt into the text beside it, on the landing page and in the dashboard.
- Checked with Claude Code on a sample Jekyll blog: with a known key it
  added the tag to `_layouts/post.html` in 31 s and three tool calls, while
  the previous prompt stopped to ask three questions and changed nothing in
  50 s; without a key it found the template and asked only for the key.
- Tests: the landing e2e checks the prompt asks for the key, says not to
  fetch anything, and stays under 230 words; the dashboard e2e checks a
  button's prompt carries its key and asks nothing.

## 2026-09-26 — The agent prompt asks before it changes anything

- The prompt now opens with the questions only the owner can answer, and
  tells the agent to wait for the answers: the button's key, which pages or
  templates get it and whether list pages show read-only counts, whether to
  count by URL or by a stable id, and every origin the site runs on (only the
  owner can allow them in the dashboard). Its steps follow those answers.
- It asks only what it does not know: the landing page's prompt asks all
  four, the dashboard's skips the key and lists the origins the button
  already allows, to confirm or add to.
- The console check now also names a wrong key (`not_found`).
- Tests: the landing e2e checks its prompt asks four questions, the key
  first; the dashboard e2e checks a button's prompt asks three, never the
  key, and lists its origins.

## 2026-09-26 — A prompt for coding agents

- The landing page's Install section has "Let your agent add it": a prompt
  to paste into Claude Code, Cursor or another coding agent, with the
  instance's address and a placeholder key. Each button's row in the
  dashboard has the same prompt, filled in with its key, snippets and allowed
  origins, under "Prompt for your coding agent".
- The prompt says where to put the tag, when to use the element with
  `data-item` or `data-readonly`, how to size it, that the key is public, to
  allow every origin the site runs on (local development included) and the
  instance in a CSP, and how to prove it works: a console check that waits
  for the button and prints its count or its error, an automated test that
  waits for `appreciator:ready` without clicking, and the events to react
  to. It ends by asking for a report of what changed.
- One copy of the wording, `site/agent-prompt.js`, is loaded by both pages.
- Tests: the landing e2e checks the prompt and its copy button, then runs
  the prompt's console check, exactly as written, on a page with a real
  button and sees it report ready. The dashboard e2e checks the row's prompt
  carries the button's key, its count position and its origins, copies it,
  and that it wraps inside the row on a narrow screen.

## 2026-09-26 — The button's events, on the landing page

- A "Listen to it" section (and an Events link in the nav) lists the events
  every button already sends: `appreciator:ready` on load, `appreciator:burst`
  on every click, `appreciator:change` when the server confirms a counted
  click, `appreciator:maxed` once the allowance is used up, and
  `appreciator:error`, each with what fires it and what `event.detail`
  carries. A snippet to copy shows the listeners, and a live log beside it
  shows the demo's events as it is clicked. On a phone, each event stacks as
  one entry instead of a cramped table.
- Both READMEs carry the same table.
- Tests: the landing e2e checks the five events are listed, the snippet, and
  that clicking the demo logs its load, the click and the confirmation, newest
  first.

## 2026-09-25 — Read-only buttons pass clicks and hover to what holds them

- A read-only button was a disabled `<button>`, and browsers swallow clicks
  on those: inside a post card's link, a click on the count went nowhere, and
  the arrow cursor replaced the link's pointer.
- Read-only now leaves the button enabled but takes the whole element off the
  pointer (`pointer-events: none` on the element itself, not only its inner
  button), out of the tab order and out of the accessibility tree, so the
  pointer goes straight to the parent for clicks, hover and the cursor.
  The element speaks as an image with the count instead, which inside a link
  joins the link's name, and it never clears a role or label the page set.
- Tests: unit tests for the attributes on and off and a page's own role left
  alone; an e2e wraps a read-only button in a link with a hover style and
  checks the hover, the pointer cursor, that a click follows the link, and
  that nothing is sent.

## 2026-09-25 — Counts sorted by last update, or by total

- A button's counts list the most recently updated first. In the dashboard,
  the Total and Updated headers sort by their column, highest or newest
  first, and clicking the header in use again flips it; it carries an arrow
  (↓ or ↑) and `aria-sort`, and opening another button's counts starts from
  Updated, newest first, again.
- `order=asc` lists either sort in exact reverse of the default
  `order=desc`, ties included, so both read the same index; a cursor
  carries its direction and is refused in the other one.
- `GET /v1/buttons/:id/items` takes `sort=updated` (the default) or
  `sort=total`, both descending with ties by key, instead of key order.
  Cursors carry their sort and last value, so paging stays exact across
  ties; one from the other sort, or an older key-only cursor, is a `400`.
  Migrations 015 and 016 index each order.
- Tests: integration tests for both orders with ties, paging one item at a
  time through each, a crafted cursor, and refused cursors and sorts; seeded
  counters share a fixed time so key order stays deterministic. An e2e makes
  real clicks on two pages a second apart, then sorts by each header.

## 2026-09-25 — Owners get a way to their site's settings from the leaderboard

- On the leaderboard, a signed-in owner's own sites carry a "Your site ·
  Settings" link to that site's page in the dashboard, where its settings
  are now at the top. It sits on a line of its own under the name, whether
  the name is a link to the site's page or plain text. No one else sees it, and the dashboard still checks
  ownership on every site route.
- Leaderboard entries carry `siteId`, the random id the site's badge
  address already shows. `GET /v1/leaderboard/mine` lists which of them the
  signed-in account owns: an empty list when signed out rather than a 401,
  `private, no-store`, and no CORS header. The page asks only when the
  instance serves it, since the GitHub Pages copy never sees the sign-in.
- Site settings move from the bottom of the site page to the top, above its
  buttons and badge.
- Tests: integration tests for ids in the list, the owner's list with
  another account's site left out, signed out and forged cookies, and the
  leaderboard switched off; an e2e where an owner sees the link on their own
  row only, follows it to the settings, and a stranger sees none.

## 2026-09-25 — Rename a site, or take it off the leaderboard

- `PATCH /v1/sites/:id` takes a new `name` and `showOnLeaderboard`
  (migration 014, on by default and for every existing site), with the same
  session, CSRF and ownership checks as the other site routes. The
  leaderboard leaves out sites that opted out; their badges keep working.
- The dashboard has "Site settings" at the top of each site's page, above
  its buttons and badge: the
  name, and "Show this site on the Most appreciated leaderboard", hidden
  where the instance has no leaderboard. Saving updates the title, the site
  list and the badge snippets, and a blank name gets a plain message.
- Tests: integration tests for renaming (trimmed), leaving and rejoining the
  leaderboard, the badge unaffected, blank names, empty or unknown changes,
  another account's site and the CSRF header; the dashboard e2e renames the
  site, takes it off and puts it back on the real leaderboard, and refuses a
  blank name.

## 2026-09-25 — Page assets are checked on every load

- The dashboard's and landing page's scripts and styles were cached for five
  minutes while their pages were never cached, so after a change a browser
  could run a fresh page with an old stylesheet or script. The count-position
  picker once seemed not to work, and the badge card's snippets once seemed
  to overflow, for exactly that reason.
- They are now `no-cache` with an `ETag`: checked on every load, answered
  with a bodiless `304` while unchanged, and sent anew after a change. The
  widget bundle embedded on other sites keeps its five-minute cache.
- Tests: every page asset has an `ETag`, a matching `If-None-Match` gets a
  `304`, and a different one gets the file.

## 2026-09-25 — A badge with each site's total appreciations

- `GET /v1/sites/:siteId/badge.svg` draws a small flat badge, like a README
  build badge: a heart, "appreciated" and the site's exact total over all its
  buttons (`1,234`). Public, cached five minutes, metered by the public read
  rate limit. `?label=` and `?color=` restyle it. An unknown site is a gray
  "not found" badge with a `404`, still an image.
- Safe anywhere: no script or external reference, escaped text,
  `nosniff` and `default-src 'none'`. Its ids are unique per badge; with
  shared ids, badges pasted inline into one page clipped each other to the
  first one's width, which the first rendering showed.
- `badge.json` answers the same in shields.io's endpoint-badge shape.
- The dashboard shows each site's badge with Markdown and HTML to copy,
  linked to the leaderboard (or the home page when it is off), with the site
  name made safe for each snippet.
- Tests: unit tests for the renderer (grouping, widths, halves adding up,
  labels, escaping, unique ids, the server's own SVG check); integration
  tests for totals across buttons and sites, a live click, options and their
  refusals, not-found, headers, no session needed, the JSON shape, and the
  session-only site routes left alone; an e2e that loads the badge in the
  dashboard, copies its snippet and reads a total that includes a click.

## 2026-09-25 — A short, quiet click sound

- Each counted click plays a soft pop, about a tenth of a second, climbing a
  little in pitch as the allowance fills. The click that fills the button
  plays a two-note chime instead, and a click on a spent button a quieter,
  lower pop. Peak level is about an eighth of full scale.
- Synthesised with Web Audio: no file to fetch, nothing for a strict CSP to
  refuse, and started only from the click, as browsers require. Where Web
  Audio is missing or refuses, nothing plays and the click works as before.
- On by default. `clickSound` on the button (migration 013, the dashboard's
  "Play a short, quiet sound on each click") turns it off everywhere;
  `data-sound="off"` on the script tag or element silences one page.
  Read-only buttons are silent.
- Tests: integration tests for the default, PATCH, a non-boolean and
  `/config`. Unit tests with a recording Web Audio: rising pops, the chime,
  the spent pop, and silence from the setting, the page and read-only, with
  a check that the same setup does play. An e2e records the notes started
  through Chromium's real Web Audio, and the dashboard e2e saves the setting
  off.

## 2026-09-25 — Read-only on the landing page and in the dashboard

- Read-only was only in the READMEs. The landing page now has a "Read-only"
  example after the count positions: the snippet, and a live read-only
  button reading the main demo's counter, which re-reads it after each click
  there so it follows along while it cannot be clicked itself. Demo slots
  can name their counter (`data-item`) and be read-only (`data-readonly`).
- The dashboard notes under each button's snippets that `data-readonly`
  works on either.
- Tests: the landing e2e checks the example is disabled, shows the main
  demo's count, ignores a forced click and follows a click on the main demo.

## 2026-09-25 — Read-only buttons

- `data-readonly` on the element or the script tag (any value but `false`),
  or `readonly: true` for `mount()`, shows the count and this visitor's fill
  but takes no clicks: the button is disabled, so nothing is sent and there
  is no pulse, burst, thank-you message or hover. Adding or removing it takes
  effect at once, without reloading. For places where the count is for
  reading, such as a list of posts.
- Tests: unit tests for the embed passthrough, `mount()`, no requests or
  bursts, the accessible name, and switching it off and on; an e2e that
  force-clicks a read-only button, then switches it off and clicks.

## 2026-09-25 — More room between the button and the thank-you message

- 0.8em of the message's size between them (was 0.4em), and 1.1em when the
  button has a ring. The landing page's room under its main demo grows to
  match.
- The element is `inline-flex` instead of `inline-block`. As an inline
  block it kept a few pixels under the button for letter descenders, so
  anything placed from its bottom edge, like the message, sat lower than
  set. It lines up with surrounding text as before.
- Tests: the e2e measures the gap with and without a ring.

## 2026-09-25 — The counts filter takes any form of site, and says what went wrong

- **Bug.** On a button's counts, Filter and Clear seemed to do nothing. The
  server accepts only an exact origin (`https://myblog.com`), so `myblog.com`
  or a trailing slash was refused, the old rows stayed, and the error was
  shown at the very bottom of the page, out of sight, where it also outlived
  Clear.
- The filter now reads a bare host (taken as https), a trailing slash or a
  whole page address as its site, and shows the origin it used. Anything
  that names no site gets a plain message right under the filter, which
  Filter and Clear remove once they load. A filter that matches nothing says
  so, and that item ids belong to no site.
- Tests: the dashboard e2e filters by a bare host, by a page address, by
  something that is not a site, and clears.

## 2026-09-25 — A shorter thank-you message

- The thank-you message stays 1.5 s instead of 3 s (`THANKS_MS`), on the
  maxing click and on each click after.

## 2026-09-25 — The thank-you message answers every click on a spent button

- A click on a button whose allowance is already used shows the thank-you
  message again, for another 3 s, alongside the burst. A visitor who comes
  back already spent still sees it only once they click.
- Tests: a unit test clicks a spent button twice and checks each click
  restarts the 3 s without counting; the e2e clicks once more after the
  message fades and sees it return.

## 2026-09-25 — A thank-you message when a visitor runs out of clicks

- Each button has a `thanksMessage` (migration 012, up to 160 characters,
  empty for none), starting as "Thank you so much, we're truly grateful.",
  set in the dashboard's "Thank-you message" field and served by `/config`.
- On the click that uses up the visitor's allowance, the widget fades it in
  under the button (above it when the count is below) and out 3 s later. It
  is 80% of the page's text size, wraps a typical message onto two lines so
  it fits small containers, and sits over what follows so nothing moves.
  Next to the edge of the window it slides back into view. Its text is put
  in only as it appears, in a `role="status"` region, so screen readers
  announce it. Later clicks and a visitor who comes back spent do not bring
  it back. It is `::part(thanks)` for host pages to restyle.
- "Try it" in the dashboard shows it, and the landing page keeps room for it
  under the main demo.
- Tests: integration tests for the default, a custom and an empty message,
  trimming, the 160-character limit, PATCH and `/config`. Unit tests for when
  it shows and goes, never for a returning visitor or an empty message, and
  a preview starting over. The e2e checks its text, size, two lines, place
  below or above the button, fading out, staying on screen next to the
  window's edge, and the dashboard field through to the saved button.

## 2026-09-25 — Deploy to Coolify when CI passes on main

- CI gains a `deploy` job that runs after every check has passed on a push
  to `main` and calls Coolify's deploy webhook with an API token, from the
  `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN` repository secrets. Without them it
  leaves a notice and deploys nothing. Deploys never overlap.
- The Coolify guide in the README says how to create the token, find the
  webhook and store both.

## 2026-09-25 — No double-tap zoom on the button

- On phones, tapping the button twice quickly zoomed the page, the browser's
  double-tap gesture. The button now sets `touch-action: manipulation`, so
  every tap is a click, and turns off text selection and the long-press
  callout, so repeated taps never select the count.
- Tests: an e2e checks the two properties and that a double click on the
  count counts twice and selects nothing.

## 2026-09-25 — Leaderboard and counts link to the pages themselves

- The leaderboard links each site to its most-clicked page instead of its
  most-clicked origin, and shows that page's address under the name, both
  one link. Clicks on the same page from two buttons are summed. Only the
  origin and path are published, never a full-URL counter's query or
  fragment, which on someone else's page can carry a session or token. A
  site's 25 most-clicked pages are considered, loopback ones skipped.
- In the dashboard's counts, a page counter is a link to the page (new tab);
  an opaque item id stays text.
- Tests: integration tests for the page choice across buttons, loopback and
  opaque keys, stripping the query and fragment, a root without a trailing
  slash, and ties. The e2e checks the leaderboard link and its address, and
  the link in the counts table.

## 2026-09-25 — Snippet scrollbars show only on hover

- A code block's scrollbar keeps its room but is transparent until the
  pointer is over the block, so it neither clutters the snippets nor shifts
  them when it appears. Trackpad and keyboard scrolling work as before.
- Tests: the dashboard e2e checks the scrollbar colour at rest and on hover.

## 2026-09-25 — Button rows: snippets use the full width beside the preview

- Counts, Edit and Delete sit on the name's line instead of in a column of
  their own, so the snippets below span the whole row next to the preview.
  On a narrow screen the preview stacks above, and the snippets take the
  full width.
- Tests: the dashboard e2e checks that a snippet starts beside the preview
  and ends at the row's edge.

## 2026-09-25 — Snippets scroll inside their block

- **Bug.** On a site's button list, a long snippet widened its row and gave
  the whole page a horizontal scrollbar. The row's text column is a grid
  track sized automatically, which cannot shrink below its content's
  smallest width, and for a `<pre>` that is the whole unbroken line. The
  column may now shrink (`minmax(0, 1fr)`), so each snippet scrolls
  horizontally inside its own block.
- Code blocks with a Copy button get room at the end of each line, so the
  last characters scroll clear of the button, on the landing page too.
- Tests: the dashboard e2e narrows the window to 700px and checks that both
  snippets stay inside the row and scroll, and that the page does not.

## 2026-09-25 — A larger count

- The count is 65% of `--appreciator-size` (was 55%): a 3rem icon gets a
  1.95rem count, and with no size set it is about 0.98× the page font.
  `::part(count)` still overrides it.
- Tests: the e2e size ratios (60px → 39px, 40px → 26px, unset → 0.975× the
  page font).

## 2026-09-25 — The burst is a pentagon aimed away from the count

- Five copies instead of six, flying to the corners of a regular pentagon
  with one corner pointing straight away from the count. The count sits in
  the middle of the widest gap, 36° from the nearest copy, whether it is
  right, left, above or below. With six copies 60° apart, one flew straight
  at a count placed above the icon.
- The copies are aimed on every burst, so a page (or the dashboard preview)
  that moves the count gets a burst that avoids it.
- Tests: a unit test checks, for each position, that one copy points
  straight away and none comes within 36°. An e2e samples every frame of a
  burst in Chromium, with and without a ring, and requires no copy's
  on-screen box ever to meet the count's.

## 2026-09-25 — More room between a ring and the count

- With a ring, the gap between the icon and the count is three quarters of
  `--appreciator-size` (a half when stacked), instead of a half (a quarter),
  so the count stands clear of the circle.
- Tests: the ring e2e measures the gap from the ring's edge to the count.

## 2026-09-25 — Choose the count position in the dashboard

- The create and edit form has a "Count position" picker (right, left,
  above, below). "Try it" moves the count as it changes, and each button
  row's preview shows the saved position.
- It is saved on the button as `countPosition` (migration 011, default
  `right`) and written into both snippets as `data-count`, left out for
  `right`. The widget is unchanged: `data-count` already placed the count.
  A page already embedding a button keeps its snippet's position until the
  snippet is pasted again.
- Tests: integration tests for the default, both snippets, PATCH and an
  unknown position. The dashboard e2e picks "left", checks the preview puts
  the count left of the icon, and checks the saved snippets, the row preview
  and the edit form.

## 2026-09-25 — A lighter ring, further from the icon

- The ring is 1px (was 2px), and set 0.3 of the icon size away from it (was
  0.18), so it frames the icon rather than crowding it.
- The burst reaches 1.5× further with a ring (was 1.3×) so it still starts
  outside it. The dashboard's preview boxes grow to keep it inside them.

## 2026-09-25 — Button list: live previews and an element snippet

- Each button row on a site shows the button as saved: its icon, colours,
  ring and cap, clickable through `preview()` with nothing sent or counted.
- Beside the one-tag embed, each row offers the script plus an
  `<appreciator-button data-key="…">` element, for pages that place the
  button themselves or show several, with its own Copy button.
- The API returns that as `elementSnippet` wherever it returns
  `embedSnippet`: the create response and every `ButtonConfig`.
- Tests: an integration test for `elementSnippet` on create and list, and
  e2e checks that the saved button's row preview is drawn with its ring and
  colour and counts a click locally, and that the element snippet is shown
  and copied.

## 2026-09-25 — Dashboard: colour table, icon ring, and a button to try

- **Colour table.** The four colours sit in a table (Default, Hover,
  Clicked, Full), each column with its picker and, under it, the icon as it
  looks in that state, drawn with the widget's own `stateIcon`. It shows in
  every icon mode:
  - the built-in heart, in the chosen colours;
  - one SVG, painted as the widget paints it, or in its own colours
    (grayscale at rest) when those are kept;
  - four SVGs, each state's own drawing.
    The colours are sent in every mode, since they also paint the ring and the
    count once full.
- **Ring.** "Draw a circle around the icon" saves `iconRing`.
- **Try it.** The end of the form holds a real `<appreciator-button>` built
  from the form through `preview()`: it fills, pulses, rolls its count,
  bursts and goes full exactly as live, with no request and nothing stored.
  It rebuilds from zero as the form changes, and "Reset preview" restarts it.
  It replaces the static image previews.
- Editing a button whose icon is the built-in heart now opens in "Built-in
  heart" mode, and saving in that mode sends the heart, so switching an
  edited button back to it takes effect.
- Tests: an e2e that draws four SVGs and then a raw SVG and checks each
  swatch's colour, ticks the ring, clicks the preview to full and past it,
  resets it, saves, and checks that no public button request was made and
  that the saved button has the ring, SVG and colour. Editing brings the
  design back.

## 2026-09-25 — Buttons follow single-page app navigation

- A button counting its page (no `data-item`) often sits in a layout the
  router keeps, so it showed the first page's count on every page. It now
  reloads once the address names a different counter: a new path, or any
  change under `full` URL counting. Fragment and query changes under the
  default path counting reload nothing.
- It listens through the Navigation API (`currententrychange`), or wraps
  `pushState`/`replaceState` and listens for `popstate` where that is
  missing. Buttons with `data-item`, which reload when it changes, and
  previews are left alone. A removed button stops listening.
- Tests: unit tests on the fallback path in jsdom (push, back and forward,
  fragment and query, `data-item`, removal), and an e2e in Chromium that
  routes between two pages, clicks on one, and goes back to its count.

## 2026-09-25 — Chosen resting colours show; icon ring; offline preview

- **Bug.** The unfilled layer of a recoloured icon was always run through
  `grayscale(1)`, so the `default` and `hover` colours were drained to gray
  and changing them had no visible effect. Grayscale now applies only when
  the icon keeps its own colours. The built-in heart looks the same, since
  its default colour is gray.
- **Ring.** `iconRing` (saved on the button, migration 010) draws a 2px
  round border around the icon. It is coloured `default`, `hover`, `clicked`
  or `full` with the state, each overridable by `--appreciator-*`. The burst
  starts and ends 1.3× further out so it clears the ring.
- **`preview(config)`** runs the element from a config alone. It needs no key
  and makes no request, and clicks settle locally through the same code path
  as live clicks.
- **`stateIcon(config, state)`** returns the icon as it looks in one state,
  painted through the CSSOM so a strict `style-src` allows it.
- `GET /web/config.json` also carries `defaultIcon` (the heart and its
  colours) for the dashboard.
- Tests: integration tests for `iconRing` (default, create, list, PATCH,
  `/config`, type check) and `defaultIcon`. Unit tests cover the preview, the
  ring and `stateIcon`. An e2e checks the ring's width, shape and colour in
  each state and that the recoloured base is no longer grayscaled.

## 2026-09-25 — Wider gap between the icon and the count

- Half of `--appreciator-size` beside the icon (was a third), a quarter when
  stacked (was a sixth).

## 2026-09-24 — Burst copies no longer zoom with the icon's pulse

- **Bug.** The burst copies lived inside `[part="icon"]`, which carries the
  click pulse (scale 1 → 1.3 → 1) and the hover grow, so every copy zoomed
  with the main icon. The previous check measured the copy's own transform,
  which excludes its parent's, and so missed it. Measured on screen, a copy's
  width went 17.6 → 20.4 → 15.8 px during a click.
- The burst layer now sits beside the icon in a shared positioning box
  (`.stage`), still centred on it but outside its transforms. On screen, a
  copy stays 15.8 px throughout.
- Tests: an e2e that hovers, clicks and samples a copy's on-screen width,
  requiring it to stay within 2%.

## 2026-09-24 — Faster burst, no zoom

- The burst's copies now travel out at one constant size (scale 0.6) instead
  of shrinking as they go, and the animation runs in 500 ms instead of
  700 ms (`BURST_MS` 800 → 600, stagger included). Measured in Chromium:
  scale stays 0.60 from start to end while the copy moves out and fades.

## 2026-09-24 — Full count in the full colour; count a step below the icon

- When a visitor's allowance is spent, the count takes the `full` colour
  (`--appreciator-full` overrides it, like the icon), fading in over 300 ms.
- The count is now 55% of `--appreciator-size` (was two thirds), so it reads
  as a step below the icon rather than matching it: a 3rem icon gets a
  1.65rem count. With no size set that is about 0.83× the page font (was
  1×). `::part(count)` still overrides it.
- Tests: e2e checks the count is not in the full colour before the cap and is
  at it, and the new size ratio (60px → 33px, 40px → 22px, unset → 0.825×
  the page font).

## 2026-09-24 — The burst plays on every click, from around the icon

- Every click now bursts, not only the one that spends the allowance and the
  ones after it. Counted clicks burst and count; clicks on a full button
  burst and count nothing, as before. Loading never bursts.
- The six copies appear just outside the icon's edge (0.6 sizes from its
  centre, `--sx`/`--sy`) and fly out to 1.5 sizes (`--dx`/`--dy`), fading in
  and out, instead of starting hidden behind the icon's centre. A softer
  ease-out curve makes the outward travel visible, and the copies are a
  little bigger (70% → 45% of their base size, was 60% → 35%).
- Tests: unit tests for a burst on every counted click and for each copy
  starting outside the icon's edge and ending further out.

## 2026-09-24 — `--appreciator-size` scales the whole button

- `--appreciator-size` used to size only the icon; the count followed the
  host page's font and the gap the button's `em`, so a bigger icon kept a
  small count. The count is now `size / 1.5` and the gap `size / 3` (`/ 6`
  stacked). With no size set these equal the previous `1em`, `0.5em` and
  `0.25em`, so default buttons look the same. `::part(count)` still sizes the
  count on its own.
- The landing page drops the `font-size` it paired with every size.
- Tests: an e2e that unsets the size (count equals the page font), then sets
  60px (count 40px, gap 20px) and 30px (count 20px).

## 2026-09-24 — Uploaded SVGs take the button's colours; keep-own-colours switch

- **Bug.** An SVG uploaded as-is rendered black and ignored the button's
  colours: the widget paints through `--appr-fill` / `--appr-stroke`, which
  only an `svg-gen`-prepared file references, so a raw file fell back to SVG's
  default black fill.
- The widget now paints every drawn element of a single icon (both layers
  and the burst) with the button's colours, overriding the file's own
  (`!important` beats presentation attributes and inline styles). Masks,
  clip paths, gradients, markers and symbols are left alone. `svg-gen` output
  looks exactly as before; `svg-gen` is now optional.
- New per-button `keepIconColors` (migration `009`, API, `/config`,
  dashboard checkbox "Keep the SVG's own colours"): draws the file as
  designed, grayscale until it fills, for multi-colour mascots and logos. The
  widget marks such buttons `data-own-colors`. Four-SVG buttons are
  untouched.
- The dashboard's "One SVG, recoloured per state" mode is now "One SVG", with
  a hint explaining which colours apply.
- Tests: `keepIconColors` round-trip, PATCH and validation (integration), the
  `/config` field, `data-own-colors` unit tests, and an e2e with a raw
  `fill="#000"` SVG proving it takes the default/full/clicked colours, and
  stays black with grayscale when keeping its own.

## 2026-09-24 — A little more room between the icon and the count

- The gap between icon and count grows from `0.35em` to `0.5em` side by side
  (`right`, `left`) and from `0.15em` to `0.25em` stacked (`top`, `bottom`).
  It scales with the host page's font size, as before.

## 2026-09-24 — Build: stop nesting migrations in dist

- `npm run build -w @appreciator/server` copied migrations with
  `cp -R src/db/migrations dist/db/migrations`. When the target already
  existed, a repeat build nested the folder (`dist/db/migrations/migrations`),
  so a locally built server kept migrating from the first build's stale copy:
  a fresh schema got 4 of the 8 migrations. It now copies the folder's
  contents (`src/db/migrations/.`). Verified by building twice and migrating a
  fresh schema from `dist`: all 8 applied. Docker and Coolify build from
  clean, so they were never affected.

## 2026-09-24 — The widget retries loads and never loses its icon

The other half of the disappearing-icons fix: a failed load no longer leaves
an empty space.

- Loads (config and counts) retry up to 3 times on 429, network failure or
  5xx, waiting `Retry-After` (0.5–10 s) or 1 s → 2 s → 4 s with ±20% jitter.
  Stale loads are abandoned on re-initialisation. Clicks are never retried.
- The config is cached per button in `localStorage` and drawn immediately on
  load, so the icon appears before the server answers and stays when it
  cannot. A fresh config only redraws when it differs.
- The config is awaited before the counts, so if only the counts fail the
  icon is still drawn; the widget reports `data-error` and stays disabled.
- Verified against production-default limits: 6 rounds of load, max and reset
  (225 reads) lost no icons, where before the fix all ten were gone by load 7.
  With reads forced below one page load, all ten icons came from the cache
  and the throttled buttons recovered on retry. Chrome coalesces a page's
  identical `/config` requests, so a load costs about 11 reads, not 20.
- Tests: retry, cached-icon and no-retry-on-404 unit tests with fake timers,
  retry timing rules, the config cache, and the allowlist e2e now waiting out
  the retry window (a blocked origin looks offline from inside the page).

## 2026-09-24 — Separate read and write rate limits; readable 429s

Fixes icons disappearing after a few reloads and a reset.

- **Root cause.** Every public request shared one per-IP budget
  (`RATE_LIMIT_MAX`, 60/min). The landing page has ten buttons, each spending
  `/state` (and `/config` once its 60 s cache expires) on every load and
  reset. Reproduced with production defaults: load 6 got a 429, loads 7–8 lost
  all ten icons, leaving only the cached counts. The e2e stack runs with the
  limit off, so no test caught it. Real sites with many buttons per page
  would hit it on first load.
- Reads (`GET`/`HEAD`/preflight) now have their own budget,
  `RATE_LIMIT_READ_MAX` (default 600/min); writes (`/click`, `/reset`) keep
  `RATE_LIMIT_MAX`. Two limiters with separate stores behind one first
  `onRequest` hook.
- A 429 from the public routes carries `Access-Control-Allow-Origin: *` and
  exposes `Retry-After`, so an embedding page can tell throttling from being
  offline, and its `error` is `rate_limited` instead of `bad_request`.
- Tests: split-budget integration tests (reads can't starve writes and vice
  versa; the 429's headers and code; the allowlist still governs every other
  response) and env tests for `RATE_LIMIT_READ_MAX`.

## 2026-09-23 — Count positions on the landing page

- "Where the count goes" under "Make it yours": four live buttons with
  `data-count` right, left, top and bottom, each captioned with its
  attribute. The multi-button example now places its counts on the left, and
  its code sample shows `data-count="left"`. Demo slots centre their button
  vertically, so the multi-button rows line up with their titles.
- Tests: a landing e2e that measures each demo's count against its icon and
  checks every side, the left-hand multi-button rows and the default hero.

## 2026-09-23 — The count rolls up instead of popping

- The count's pop is replaced by an odometer roll: on a counted click the old
  number slides up and out while the new one slides in from below, clipped to
  the count's own line so the layout never moves (~320 ms). Only the
  visitor's own counted clicks roll it; loading, a server correction, a
  refresh or reset, and burst-only clicks swap it without animating. Rapid
  clicks finish the previous roll at once. `ROLL_MS` is exported.
- Tests: roll unit tests (rolls on a click, one number leaving under rapid
  clicks, no roll on load/rollback/refresh/burst) and an e2e roll check that
  the count's height doesn't change mid-roll.

## 2026-09-23 — Count position and count pop

- `data-count="right|left|top|bottom"` on the element (or the one-tag
  `<script>`, which now passes it through) places the count on any side of
  the icon; missing or unknown values mean `right`, as before. Pure CSS on
  `:host`, so it can be changed live.
- On every counted click the count pops: it grows to 1.25× and flashes the
  `clicked` colour for the length of the icon's pulse (350 ms), restarting on
  rapid clicks. Spent-button clicks (burst only) don't pop it. Reduced motion
  turns it off.
- Tests: embed passthrough unit test; e2e comparing the count's and icon's
  boxes for all four positions, the default and an unknown value, and the
  count's animation during and after a click.

## 2026-09-23 — Burst at 100%, and "Reset my votes" on the landing demo

- **Burst.** The click that spends a visitor's allowance throws six small
  full-colour copies of the icon out of the button, 60° apart, over ~0.7 s.
  Every click after that counts nothing (no request) and replays the burst.
  A button that loads already spent stays still. Particles are parsed (not
  cloned) for host-CSP safety and live in `::part(burst)`; reduced motion
  hides them. New `appreciator:burst` event.
- **A spent button stays clickable.** It is no longer `disabled`; it carries
  `aria-disabled="true"` and an accessible name ending "all used".
  (Playwright treats `aria-disabled` as not clickable, so the e2e specs
  force-click it and assert the `disabled` property directly.)
- **`refresh()`** on the element re-reads config and counts, skipping the
  cached counts so a just-reset button doesn't flash full.
- **`POST /v1/buttons/:publicKey/reset`**, demo button only: removes the
  caller's clicks on every demo item and subtracts them from the totals.
  Any other key gets the same 404 as an unknown one, so real caps can't be
  reset. Origin-checked and rate-limited like the other public routes.
- **Landing page.** "Reset my votes" sits next to "Try it" in the hero box,
  hidden until the hero demo is used up (it follows the widget's
  `appreciator:ready` / `appreciator:change` events) and hidden again after a
  reset. It resets through the endpoint and calls `refresh()` on every demo
  button on the page.
- Tests: 8 reset integration tests (real MySQL), burst/refresh/aria unit
  tests, and a landing e2e that spends the remaining allowance, sees the
  burst and the reset button, clicks once more without a request, resets,
  and counts again.

## 2026-09-23 — Progress fill: the icon colours in as the visitor clicks

- Every single-icon button now shows progress toward the per-visitor cap: a
  gray silhouette with a coloured copy on top, revealed bottom-up by
  `visitorCount / maxClicks` (optimistic clicks included) through a
  `clip-path` driven by `--appr-progress`. Replaces the outline → filled look
  for all such buttons, including ones already embedded.
- All four colours keep a meaning: `default`/`hover` paint the silhouette,
  `full`/`clicked` the filled part. The silhouette also gets `grayscale()`,
  so an icon that ignores the colour variables still starts gray, which is
  the groundwork for uploading any multi-colour SVG as-is.
- The first click gets a 10-point head start (fill = 10% + 90% × spent), so
  it shows even where the bottom tenth of the icon's box is empty; the last
  click still lands on exactly 100%. Each rise eases in over 800 ms
  (`cubic-bezier(0.22, 1, 0.36, 1)`). Measured before the change: the fill
  did animate, but 10% of the box over 400 ms mostly inside the heart's
  empty tip was easy to miss.
- The host reflects `data-progress` (0–100, the honest share spent; only the
  drawn fill carries the head start). The pulse and hover scale moved
  to `::part(icon)` so both layers move together; reduced motion disables
  the reveal transition too.
- The icon is parsed twice rather than cloned, because a clone would copy
  `style` attributes that a strict host CSP refuses.
- Four-SVG buttons keep their per-state swap and show no progress yet.
- The reveal is mapped onto the drawing, not the icon's box: the widget
  measures the drawing's extent with `getBBox()` (plus half the stroke,
  within the viewBox, allowing for letterboxing) and clips between its real
  top and bottom. On the heart the first click went from a sliver to a clear
  tip (inset 81% → 76.6%). The geometry lives in `src/fill.ts` as pure
  functions; it falls back to the whole box until the icon is laid out.
- Tests: unit (progress helper, layers, optimistic progress, cached progress),
  e2e in Chromium asserting silhouette and fill colours and the computed
  `clip-path` at 0, 10% and 100%.

## 2026-09-23 — Self-serve dashboard, sign-in, per-state icons, and the last gaps

Everything the "known gaps" list and the landing/dashboard request asked for,
landed as phases A–E on `main`.

- **Server, gap fixes (A).** `https://*.example.com` wildcard origins (apex
  excluded, same scheme and port); `?origin=` filter on the items listing
  (prefix match on the item key, LIKE-escaped); `/widget.js` gets its own
  per-IP limit (`WIDGET_RATE_LIMIT_MAX`); buttons gain `name` and
  `svgSources` (four SVGs, one per state, each validated like `svgSource`;
  `conflicting_icon` when both are sent); every `ButtonConfig` carries its
  `embedSnippet`. Body limit raised to 512 KiB for four 64 KiB icons.
- **Server, accounts and sign-in (B).** `accounts` table and
  `tenants.account_id`; stateless signed session cookie with a CSRF header +
  origin rule; GitHub OAuth (`/auth/github`, callback, logout, `/auth/me`)
  restricted to `GITHUB_ALLOWED_LOGINS`; sites API (`/v1/sites`, rotate key,
  delete, 20 per account under a row lock); the management routes mounted a
  second time under `/v1/sites/:siteId` for the session; demo button
  provisioned at start (`DEMO_BUTTON`, `DEMO_ALLOWED_ORIGINS`) and
  `GET /config.json`; public `GET /v1/leaderboard` (`LEADERBOARD`). Found and
  fixed on the way: the public rate limiter ran after the button lookup, so
  rejected requests were never counted.
- **Widget (C).** Renders four icons with `data-for` when a button has
  `svgSources` and shows exactly one per state (hover still CSS-only);
  `data-icons="single|states"` on the host. `svg-gen --explicit` also writes
  a ready-to-post `svgSources.json`; `examples/icons/explicit/` star set.
- **Pages (D).** Landing page and leaderboard in `site/` (static, relative
  paths, GitHub Pages workflow), dashboard in `packages/server/src/web/`,
  all served by the API under a strict CSP; the widget was made CSP-clean
  (constructed stylesheet, icon `style` attributes applied through the CSSOM).
  Dashboard onboarding: first sign-in opens "name your site", then "create
  your first button", then the highlighted snippet.
- **Packaging and docs (E).** Dockerfile copies `site/`; README rewritten
  around the new flow (quick tour, Coolify step by step including the GitHub
  OAuth app, dashboard guide, GitHub Pages, full API and config tables).
- Tests: 189 unit, 241 integration (real MySQL), 14 e2e (Chromium against
  the real server: widget in both icon modes, landing, leaderboard, the whole
  dashboard flow).

## 2026-09-22 — Landing page, leaderboard page and dashboard served by the API

- **Pages.** `site/` (landing and leaderboard, also deployed to GitHub Pages
  by `.github/workflows/pages.yml`) and `packages/server/src/web/` (the
  dashboard) are served by the server: `/`, `/leaderboard`, `/dashboard`,
  `/site/<file>`, `/web/<file>`, and `/<file>` for the landing page's relative
  asset links, plus `/config.json` alongside `/web/config.json`. Only
  html/css/js/svg, paths checked to stay in their folder, pages `no-store`,
  assets `max-age=300`, and `nosniff`, `X-Frame-Options: DENY` and a CSP with
  no inline code on every response. `npm run build` copies both folders into
  `dist/`. The Dockerfile still needs `COPY site site` before the server
  build.
- **Dashboard** talks to the real sites and buttons API with the session
  cookie and CSRF header, and walks a new account through site → API key
  shown once → first button → highlighted snippet. Draft fixes: a copy button
  read `event.currentTarget` after an await, clipboard failures now change the
  label, the first route renders once, the leaderboard link hides when it is
  off, and `[hidden]` now wins over class display rules.
- **Widget under CSP.** Shadow styles are a constructed stylesheet, and the
  sanitizer keeps an icon's `style` attributes away from the parser and applies
  them through the CSSOM, so a `style-src` without `'unsafe-inline'` no longer
  breaks the button.
- **e2e.** The Playwright harness provisions the demo button, switches the
  leaderboard and sign-in on, seeds an account and mints its session cookie
  into the fixture. New specs: landing (zero console errors and CSP
  violations, live demo click, snippet, sign-in CTA), leaderboard (delta from
  real clicks, demo tenant absent), dashboard (the whole flow through counts,
  origin filter, edit, key rotation, deletes and sign-out).

## 2026-09-22 — Full README with architecture diagrams

- README rewritten as the complete system reference: who it is for (self-host
  model, no signup), features, architecture, click sequence, button states,
  data model, HTTP API, widget embedding and theming, icons, a hosting guide
  (Coolify, Docker, bare Node), configuration reference, security model,
  operations and limits, development, known gaps.
- Four Mermaid diagrams (components, click sequence, button state machine,
  entity relationships), rendered natively by GitHub so there are no image
  files to keep in sync. Each was rendered in headless Chromium before commit;
  two Mermaid pitfalls found on the way: `;` inside message text ends a
  statement (so no HTML entities there) and `default` is a reserved state name.

## 2026-09-22 — One-tag embed and env-configured management key

Two steps that stood between a deployed server and a working button are gone:
running a CLI inside the container to obtain a secret, and assembling an SVG
payload to create a button.

- **One-tag embed.** The widget bundle now reads `document.currentScript`: its
  `src` becomes the default API base (origin plus any path prefix), and if the
  tag carries `data-key` a button is rendered right after it, with `data-item`,
  `data-label`, `data-target` and `data-api` as options. `data-api` on the
  element is optional whenever the bundle came from the server. The server's
  `embedSnippet` is now that single tag, and the example page uses it, so the
  e2e run covers auto-mounting.
- **`MANAGEMENT_SECRET`.** Optional env var; on startup the server provisions
  a tenant named `default` whose secret is that value (idempotent, race-safe on
  the unique hash index). The key then lives with the other secrets in Coolify
  rather than in a one-time terminal print. Rotating it makes a new tenant; the
  old one keeps its buttons. Values under 32 characters are refused.
- **Buttons without an icon.** `POST /v1/buttons` requires only
  `allowedOrigins`; `svgSource` and `colors` default to the Feather heart from
  the example, kept as a string constant in the server so the image needs no
  extra assets.
- **`GET /v1/buttons`** lists the tenant's buttons with their public keys, so a
  key never has to be written down after creation.
- The `create-tenant` CLI stays for additional tenants.

## 2026-09-22 — Production Dockerfile for Coolify

- Multi-stage `Dockerfile`: builds shared, widget and server, then a slim
  `node:22-alpine` runtime with only the server's production dependencies and
  the three `dist` folders. Runs migrations, then the server, as `node`.
- `HEALTHCHECK` on `/healthz`; `.dockerignore` keeps the build context small.
- README gains a Deploying section with the Coolify steps (Dockerfile build
  pack, MySQL resource, `TRUST_PROXY=true` behind the Coolify proxy).
- Verified locally: image built, ran against the compose MySQL, served
  `/healthz` and `/widget.js`, and `create-tenant` worked inside the container.

## 2026-09-22 — Initial build: server, widget, svg-gen, example, CI

Greenfield. Everything below landed in one branch of small commits.

### Decisions

- Multi-tenant API (secret-key management routes, public-key widget routes,
  per-button origin allowlist) rather than one deployment per site.
- Node + TypeScript, Fastify, `mysql2` with hand-written SQL migrations — no
  ORM, because the click increment is an atomic guarded `UPDATE`.
- Visitor identity for the per-visitor cap is a keyed HMAC of IP + user agent.
  The first implementation also mixed in a client-generated id, which made the
  cap resettable by clearing `localStorage`; that was removed and the
  `visitor` field dropped from the public API.
- One source SVG per button, recoloured per state through CSS custom
  properties, instead of trying to derive four shapes automatically.
- Counter key defaults to origin + path of the page URL; explicit `data-item`
  overrides it.

### Server (`packages/server`)

- Migrations for `tenants`, `buttons`, `items`, `visitor_clicks`.
  `item_key` is `VARCHAR(512)`, not the planned 767: the composite primary key
  exceeded InnoDB's 3072-byte index limit on MySQL 8.4.
- Management routes: create / patch / list items / delete a button.
- Public routes: `GET …/config`, `GET …/state`, `POST …/click`; `GET /widget.js`
  serves the built bundle (`WIDGET_BUNDLE_PATH`).
- `create-tenant` CLI, since only a hash of the management secret is stored
  and there is no signup endpoint.
- Stored-SVG guard (denylist of script vectors, 64 KiB cap) and colour
  pattern validation, because icons are rendered into third-party pages.
- Auth and origin checks run at `onRequest`, ahead of schema validation, so an
  unauthenticated request cannot learn the body schema from a 400.
- Concurrency integration test that fires overlapping clicks and asserts the
  cap holds; verified to fail against a check-then-act implementation.

### Widget (`packages/widget`)

- `<appreciator-button>` web component with a shadow root; attributes
  `data-api`, `data-key`, `data-item`, `data-label`; reflects `data-state`
  (`default` / `clicked` / `full`) and `data-error`; dispatches
  `appreciator:ready|change|maxed|error`.
- Renders cached counts instantly, hydrates config + state in parallel,
  sends clicks one at a time while showing them optimistically, locks into
  `full` when the server says the visitor is maxed.
- Re-parses the icon as XML and strips script elements / handlers before
  inserting it.
- `tsup` build: `dist/widget.js` (IIFE), `dist/widget.mjs` (ESM), types.
- Unit tests in jsdom with a fake `fetch`; Playwright e2e against the real
  server, MySQL and the built bundle, on a separate origin so the allowlist is
  exercised.

### svg-gen (`packages/svg-gen`)

- `generate <icon.svg>` normalises the icon (strips `fill`/`stroke`, keeps
  `url(#…)` paint servers, sets the CSS variables on the root) and writes
  `icon.svg` + `colors.json`.
- `generate --explicit a b c d` packages four hand-made SVGs — not yet consumed
  by the server or widget.

### Example and CI

- `examples/icons/heart.svg` → `examples/plain-html/appreciator-out/` generated
  by the CLI; `examples/plain-html/index.html` takes `api`, `key`, `item` from
  the query string.
- GitHub Actions: MySQL service container; lint, format, typecheck, unit,
  integration, e2e (Chromium).

### Known gaps

See the "Known gaps" section of the README.
