import { useLayoutEffect, type RefObject } from "react";

/** Overlays mounted so far; a close that sees this move took no exit alone. */
let mounts = 0;

/**
 * Lets an overlay that unmounts with its owner leave on its exit motion rather
 * than vanish. Dialogs are rendered conditionally by whoever opens them, so
 * nothing stays mounted to play an exit; instead, once React has removed the
 * overlay's own elements, they go back where they were as a picture: the same
 * nodes, so a typed field, a scroll position and a canvas look exactly as they
 * did, but inert, hidden from assistive technology and from pointer, with no
 * role, and marked `data-leaving` for the stylesheet's exit animation. They
 * are removed when it ends.
 *
 * It stays a plain disappearance where an exit would mislead or cost:
 * - another overlay mounted in the same commit (a tool replacing its loading
 *   shell, Settings replacing its own), which arrives in its place;
 * - an iframe inside, which would reload on being put back;
 * - reduced motion, or no animation attached (jsdom).
 */
export function useExitPicture(refs: readonly RefObject<HTMLElement | null>[]) {
  useLayoutEffect(() => {
    mounts += 1;
    return () => {
      const generation = mounts;
      // Read here, not on mount: a portal fills in a commit after its owner.
      // React detaches the refs and removes the elements after this cleanup.
      const places = refs.map((ref) => ref.current)
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => ({ node, parent: node.parentNode, next: node.nextSibling }));
      queueMicrotask(() => {
        if (mounts !== generation) return;
        // Still in the document: StrictMode replaying the effect, not a close.
        if (places.some(({ node, parent }) => node.isConnected || !parent?.isConnected)) return;
        if (places.some(({ node }) => node.querySelector("iframe"))) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        for (const { node, parent, next } of places) {
          node.inert = true;
          node.setAttribute("aria-hidden", "true");
          node.removeAttribute("role");
          node.removeAttribute("aria-modal");
          node.setAttribute("data-leaving", "");
          parent!.insertBefore(node, next?.parentNode === parent ? next : null);
        }
        const remove = () => places.forEach(({ node }) => node.remove());
        const animations = places.flatMap(({ node }) => node.getAnimations?.() ?? []);
        if (!animations.length) {
          remove();
          return;
        }
        void Promise.allSettled(animations.map((animation) => animation.finished)).then(remove);
      });
    };
    // The refs are the overlay's own elements, fixed for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
