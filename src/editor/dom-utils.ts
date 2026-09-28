/** Small DOM helpers shared by hand-built editor chrome (tooltips, popups, panels). */

/** A detached element with an optional class name and text. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type Listener = [type: string, listener: (event: never) => void, options?: boolean | AddEventListenerOptions];

/** Add every listener to `target`; the returned function removes them all. */
export function listen(target: EventTarget, listeners: Listener[]): () => void {
  for (const [type, listener, options] of listeners) target.addEventListener(type, listener as EventListener, options);
  return () => {
    for (const [type, listener, options] of listeners) target.removeEventListener(type, listener as EventListener, options);
  };
}

/** Run `task` when the browser is idle (or after `fallbackMs` without idle callbacks); returns a canceller. */
export function whenIdle(task: () => void, timeout: number, fallbackMs: number): () => void {
  if ("requestIdleCallback" in window) {
    const idle = window.requestIdleCallback(task, { timeout });
    return () => window.cancelIdleCallback(idle);
  }
  const timer = globalThis.setTimeout(task, fallbackMs);
  return () => globalThis.clearTimeout(timer);
}
