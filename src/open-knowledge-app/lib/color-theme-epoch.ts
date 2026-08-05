/**
 * Local seam — not upstream code.
 *
 * Upstream bumps an epoch whenever its configurable color theme changes so
 * lowlight-highlighted code re-renders with fresh palette values. This host's
 * only runtime theme signal is `:root[data-theme]`, so the epoch increments
 * when that attribute changes.
 */
import { useSyncExternalStore } from "react";

let epoch = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function ensureObserver() {
  if (observer || typeof document === "undefined") return;
  observer = new MutationObserver(() => {
    epoch += 1;
    for (const listener of listeners) listener();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function subscribe(onChange: () => void): () => void {
  ensureObserver();
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useColorThemeEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => 0);
}
