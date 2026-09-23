import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiBaseFromScriptSrc, autoMount } from '../../src/embed.js';
import { AppreciatorButton, define, setDefaultApi } from '../../src/index.js';
import { installFakeServer, type FakeServer } from './fake-server.js';

const KEY = `pk_${'c'.repeat(32)}`;

/** A script tag as the browser would hand it to `document.currentScript`. */
function scriptTag(attributes: Record<string, string>, parent: Element = document.body) {
  const script = document.createElement('script');
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  parent.append(script);
  return script;
}

describe('apiBaseFromScriptSrc', () => {
  it('is the origin when the bundle sits at the root', () => {
    expect(apiBaseFromScriptSrc('https://appreciator.test/widget.js')).toBe(
      'https://appreciator.test',
    );
  });

  it('keeps a path prefix and drops the query string', () => {
    expect(apiBaseFromScriptSrc('https://x.test/appreciator/widget.js?v=3')).toBe(
      'https://x.test/appreciator',
    );
  });

  it('keeps a non-default port', () => {
    expect(apiBaseFromScriptSrc('http://127.0.0.1:3100/widget.js')).toBe('http://127.0.0.1:3100');
  });

  it('resolves a relative src against the document', () => {
    expect(apiBaseFromScriptSrc('/assets/widget.js')).toBe(`${location.origin}/assets`);
  });

  it('refuses anything that is not http(s)', () => {
    expect(apiBaseFromScriptSrc('')).toBeUndefined();
    expect(apiBaseFromScriptSrc('data:text/javascript,1')).toBeUndefined();
    expect(apiBaseFromScriptSrc('blob:https://x.test/abc')).toBeUndefined();
  });
});

describe('autoMount', () => {
  let server: FakeServer;

  beforeEach(() => {
    define();
    localStorage.clear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    setDefaultApi('https://api.test');
    server = installFakeServer();
  });

  afterEach(() => {
    setDefaultApi(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ignores a script tag without data-key', () => {
    expect(autoMount(scriptTag({ src: 'https://api.test/widget.js' }))).toBeUndefined();
    expect(autoMount(null)).toBeUndefined();
    expect(autoMount(document.createElement('div'))).toBeUndefined();
    expect(document.querySelector('appreciator-button')).toBeNull();
  });

  it('places a button right after the tag and copies the options onto it', async () => {
    const script = scriptTag({
      'data-key': KEY,
      'data-item': 'post-7',
      'data-label': 'Clap',
      'data-count': 'top',
      'data-nonsense': 'ignored',
    });

    const element = autoMount(script);

    expect(element).toBeInstanceOf(AppreciatorButton);
    expect(script.nextElementSibling).toBe(element);
    expect(element?.dataset).toMatchObject({
      key: KEY,
      item: 'post-7',
      label: 'Clap',
      count: 'top',
    });
    expect(element?.dataset.api).toBeUndefined();
    expect(element?.dataset.nonsense).toBeUndefined();

    await element?.whenReady();
    expect(server.requests.map((request) => request.url)).toEqual([
      `https://api.test/v1/buttons/${KEY}/config`,
      `https://api.test/v1/buttons/${KEY}/state?item=post-7`,
    ]);
    expect(element?.getAttribute('data-state')).toBe('default');
  });

  it('honours an explicit data-api over the bundle origin', async () => {
    const element = autoMount(scriptTag({ 'data-key': KEY, 'data-api': 'https://other.test' }));

    await element?.whenReady();
    expect(server.requests[0]?.url).toBe(`https://other.test/v1/buttons/${KEY}/config`);
  });

  it('renders into data-target when it names an element', () => {
    document.body.innerHTML = '<div id="slot"></div>';
    const script = scriptTag({ 'data-key': KEY, 'data-target': '#slot' });

    const element = autoMount(script);

    expect(element?.parentElement?.id).toBe('slot');
    expect(script.nextElementSibling).toBeNull();
  });

  it('warns and renders nothing when data-target matches no element', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const element = autoMount(scriptTag({ 'data-key': KEY, 'data-target': '#missing' }));

    expect(element).toBeInstanceOf(AppreciatorButton);
    expect(element?.isConnected).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('appends to the body when the tag lives in the head', () => {
    const script = scriptTag({ 'data-key': KEY }, document.head);

    const element = autoMount(script);

    expect(element?.parentElement).toBe(document.body);
    expect(document.head.querySelector('appreciator-button')).toBeNull();
  });

  it('waits for the document to be parsed before looking for the target', () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const script = scriptTag({ 'data-key': KEY, 'data-target': '#late' });

    const element = autoMount(script);
    expect(element?.isConnected).toBe(false);

    document.body.innerHTML += '<div id="late"></div>';
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(element?.parentElement?.id).toBe('late');
  });
});
