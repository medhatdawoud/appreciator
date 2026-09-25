import { AppreciatorButton, setDefaultApi, type MountOptions } from './element.js';
import { apiBaseFromScriptSrc, autoMount } from './embed.js';

export { ApiClient, ApiError } from './api.js';
export {
  AppreciatorButton,
  BURST_MS,
  BURST_PARTICLES,
  PULSE_MS,
  ROLL_MS,
  THANKS_MS,
  getDefaultApi,
  setDefaultApi,
} from './element.js';
export { apiBaseFromScriptSrc, autoMount } from './embed.js';
export { stateIcon } from './preview.js';
export type { StateIconConfig } from './preview.js';
export type { ErrorDetail, MountOptions } from './element.js';
export type { VisualState } from './state.js';

export const TAG_NAME = 'appreciator-button';

/** Registers the custom element. Safe to call more than once. */
export function define(tagName: string = TAG_NAME): void {
  if (customElements.get(tagName) === undefined) {
    customElements.define(tagName, AppreciatorButton);
  }
}

/** Creates a button, appends it to `target` and returns it. */
export function mount(target: Element, options: MountOptions): AppreciatorButton {
  define();
  const element = new AppreciatorButton();
  if (options.api !== undefined) element.dataset.api = options.api;
  element.dataset.key = options.key;
  if (options.item !== undefined) element.dataset.item = options.item;
  if (options.readonly === true) element.dataset.readonly = '';
  target.append(element);
  return element;
}

if (typeof customElements !== 'undefined') {
  define();

  // `document.currentScript` is the classic <script> tag executing this
  // bundle (null for ES modules, which use `mount()` instead). Its `src` tells
  // us which server to talk to by default, and its `data-*` attributes may ask
  // for a button to be rendered right here.
  const script = typeof document === 'undefined' ? null : document.currentScript;
  if (script instanceof HTMLScriptElement) {
    const base = apiBaseFromScriptSrc(script.src);
    if (base !== undefined) setDefaultApi(base);
    autoMount(script);
  }
}
