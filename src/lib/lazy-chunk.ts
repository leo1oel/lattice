import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** A dynamic import that runs at most once and can say whether it has arrived. */
export type Chunk<T> = (() => Promise<T>) & {
  /** The module once its import has resolved; undefined until then. */
  loaded: () => T | undefined;
};

/**
 * One lazily loaded chunk, shared by every caller: whoever asks first starts
 * the import, and every later caller gets its outcome, a failure included.
 *
 * A failed import is not asked for again. The module map keeps a module whose
 * evaluation threw, and a second `import()` of a module that depends on it
 * does not reliably report that error: WebKit resolved it and handed back
 * bindings that were never initialized, so the caller crashed on "Cannot
 * access uninitialized variable" and the real error (a missing built-in in
 * PDF.js, #506) never reached the log or the crash page. Kept, the first
 * error is the one the lazy component throws to its error boundary.
 */
export function chunk<T>(load: () => Promise<T>): Chunk<T> {
  let module: T | undefined;
  let pending: Promise<T> | undefined;
  const get = () => pending ??= load().then((value) => (module = value));
  return Object.assign(get, { loaded: () => module });
}

/**
 * `React.lazy` over a component of `source` that renders at once when the
 * chunk is already in, warmed at idle or loaded by another caller.
 *
 * `React.lazy` suspends on its first render even when the import has long
 * resolved: its promise settles a microtask later. React then commits the
 * nearest Suspense fallback and, by its reveal throttle, holds the component
 * back until 300 ms after that commit, so a first open of a warmed chunk took
 * as long as a cold one. A thenable that resolves as it is asked lets React
 * read the component in the same render.
 */
export function lazyChunk<T, P extends object>(
  source: Chunk<T>,
  pick: (module: T) => ComponentType<P>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => {
    const module = source.loaded();
    if (module === undefined) return source().then((loaded) => ({ default: pick(loaded) }));
    const ready = { default: pick(module) };
    // React.lazy calls `then` once and reads the payload right after: a
    // thenable, which its type (a Promise) cannot say.
    return { then: (resolve: (value: typeof ready) => void) => resolve(ready) } as unknown as Promise<typeof ready>;
  });
}
