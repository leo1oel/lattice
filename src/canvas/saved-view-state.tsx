/**
 * A surface's saved place (scroll, page, camera), read as the surface mounts.
 *
 * The per-file view states live in a store that changes without rendering
 * anything: a scroll is filed away and nobody re-renders for it. The canvas is
 * compiled, so an element it built earlier can mount again unchanged, when a
 * panel wakes from hibernation or Trellis moves it. Read while the canvas
 * renders, its place would be what the store held when that element was
 * built; read here, it is where the surface was left. Give it the `key` its
 * surface remounts by, so the two mount together.
 */
import { useState, type ReactNode } from "react";

export function SavedViewState<T>({ read, children }: { read: () => T; children: (saved: NoInfer<T>) => ReactNode }) {
  const [saved] = useState(read);
  return children(saved);
}
