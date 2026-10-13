import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** A dynamic import that runs at most once and can say whether it has arrived. */
export type Chunk<T> = (() => Promise<T>) & {
  /** The module once its import has resolved; undefined until then. */
  loaded: () => T | undefined;
};

/**
 * One lazily loaded chunk, shared by every caller: whoever asks first starts
 * the import, and a failed import is asked for again next time, as a fresh
 * `import()` would be.
 */
export function chunk<T>(load: () => Promise<T>): Chunk<T> {
  let module: T | undefined;
  let pending: Promise<T> | undefined;
  const get = () => pending ??= load().then(
    (value) => (module = value),
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  );
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
