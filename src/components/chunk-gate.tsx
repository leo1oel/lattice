import { useSyncExternalStore, type ReactNode } from "react";
import type { Chunk } from "../lib/lazy-chunk";

/** Chunks whose load failed: their gate opens, so their lazy component reports the failure. */
const failed = new WeakSet<Chunk<unknown>>();

/**
 * Gates to open, flushed in one task: chunks that arrive back to back open
 * their gates in one commit, not one commit each.
 */
const opening = new Set<() => void>();
function open(notify: () => void) {
  if (!opening.size) {
    setTimeout(() => {
      const gates = [...opening];
      opening.clear();
      for (const gate of gates) gate();
    });
  }
  opening.add(notify);
}

/**
 * `children` once `chunk` has loaded, `fallback` until then; it starts the
 * load. Wrap a `lazyChunk` component (in its Suspense boundary, which only a
 * failed load still reaches) that is part of what a window shows from the
 * start, as the parts of a project's first frame are.
 *
 * A lazy component that suspends commits its boundary's fallback, and React
 * then holds every Suspense reveal until 300 ms after the latest fallback
 * commit: opening a project sat that long on an empty workspace, and again on
 * an empty PDF preview, after their code had arrived. Behind a gate a part
 * shows its own placeholder instead, never a fallback, and appears in the
 * commit its chunk arrives in. A store, so each part shows at once rather than
 * waiting to render with the rest of its parent's updates.
 */
export function ChunkGate({ chunk: source, fallback = null, children }: {
  chunk: Chunk<unknown>;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const ready = useSyncExternalStore(
    (notify) => {
      let current = true;
      const settle = () => {
        if (current) open(notify);
      };
      if (source.loaded() === undefined && !failed.has(source)) {
        source().then(settle, () => {
          failed.add(source);
          settle();
        });
      }
      return () => {
        current = false;
        opening.delete(notify);
      };
    },
    () => source.loaded() !== undefined || failed.has(source),
  );
  return ready ? children : fallback;
}
