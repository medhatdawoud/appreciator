import { AppreciatorButton, type MountOptions } from './element.js';

export { ApiClient, ApiError } from './api.js';
export { AppreciatorButton, PULSE_MS } from './element.js';
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
  element.dataset.api = options.api;
  element.dataset.key = options.key;
  if (options.item !== undefined) element.dataset.item = options.item;
  target.append(element);
  return element;
}

if (typeof customElements !== 'undefined') {
  define();
}
