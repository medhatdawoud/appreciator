import { AppreciatorButton } from './element.js';

/**
 * Single-tag embedding.
 *
 *   <script src="https://appreciator.example.com/widget.js" data-key="pk_…" async></script>
 *
 * When the bundle is loaded from a script tag that carries `data-key`, a
 * button is created for it right where the tag sits (or inside `data-target`),
 * and the server it talks to is the one the bundle was loaded from. The host
 * page never has to know the API URL or the element name.
 *
 * Options are the script tag's `data-*` attributes:
 *
 * | Attribute     | Description                                                          |
 * | ------------- | -------------------------------------------------------------------- |
 * | `data-key`    | The button's public key. Required for auto-mounting.                 |
 * | `data-item`   | Explicit counter id. Defaults to the page URL.                       |
 * | `data-count`  | Where the count sits: `right` (default), `left`, `top` or `bottom`.
 * | `data-label`  | Accessible name prefix. Defaults to `Appreciate`.                    |
 * | `data-readonly` | Show the count without taking clicks.                              |
 * | `data-target` | CSS selector of the element to render into. Defaults to after the tag. |
 * | `data-api`    | Server base URL. Defaults to where the bundle was loaded from.       |
 */

/** The `data-*` attributes copied from the script tag onto the element. */
const PASSTHROUGH = ['api', 'key', 'item', 'label', 'count', 'readonly'] as const;

/**
 * Derives the API base URL from the bundle's own URL: the origin plus any path
 * prefix in front of the file name, so `https://x.test/widget.js` gives
 * `https://x.test` and `https://x.test/appreciator/widget.js` gives
 * `https://x.test/appreciator`. Anything that is not an http(s) URL yields
 * `undefined` rather than a guess.
 */
export function apiBaseFromScriptSrc(src: string): string | undefined {
  if (src.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(src, typeof document === 'undefined' ? undefined : document.baseURI);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const directory = url.pathname.replace(/\/[^/]*$/, '');
  return `${url.origin}${directory}`;
}

function whenParsed(callback: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

/**
 * Creates a button for a script tag that carries `data-key`.
 *
 * Returns the element, or `undefined` when the tag is not one of ours. The
 * element is placed synchronously when it can be (directly after a tag in the
 * body); when a `data-target` is named, or the tag sits in `<head>`, placement
 * waits until the document has been parsed so the target can exist.
 */
export function autoMount(script: Element | null | undefined): AppreciatorButton | undefined {
  if (!(script instanceof HTMLScriptElement)) return undefined;
  const key = script.dataset.key;
  if (key === undefined || key.length === 0) return undefined;

  const element = new AppreciatorButton();
  for (const name of PASSTHROUGH) {
    const value = script.dataset[name];
    if (value !== undefined) element.dataset[name] = value;
  }

  const target = script.dataset.target;
  if (target === undefined && script.closest('head') === null) {
    script.insertAdjacentElement('afterend', element);
    return element;
  }

  whenParsed(() => {
    const host = target === undefined ? document.body : document.querySelector(target);
    if (host === null) {
      console.warn(`appreciator: no element matches data-target="${target}"`);
      return;
    }
    host.append(element);
  });
  return element;
}
