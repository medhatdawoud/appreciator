/**
 * Tells listeners when the page's address changes without a page load: a
 * single-page app's router pushing or replacing history, back and forward,
 * and in-page anchors.
 *
 * The Navigation API reports all of these as a change of the current entry.
 * Where it is missing, `pushState`/`replaceState` are wrapped (once, for
 * every button) and `popstate` covers back, forward and anchors.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let installed = false;

function notify(): void {
  for (const listener of listeners) listener();
}

interface NavigationLike {
  addEventListener(type: 'currententrychange', listener: () => void): void;
}

function install(): void {
  installed = true;
  const navigation = (window as Window & { navigation?: NavigationLike }).navigation;
  if (navigation !== undefined && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('currententrychange', notify);
    return;
  }
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      original.apply(this, args);
      notify();
    };
  }
  window.addEventListener('popstate', notify);
}

/** Calls `listener` after every soft navigation; returns the function that stops it. */
export function onNavigate(listener: Listener): () => void {
  if (!installed) install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
