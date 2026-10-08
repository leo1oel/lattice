import { useLayoutEffect, type RefObject } from "react";

/** Overlays mounted so far; a close that sees this move took no exit alone. */
let mounts = 0;

/**
 * Lets an overlay that unmounts with its owner leave on its exit motion rather
 * than vanish. Dialogs are rendered conditionally by whoever opens them, so
 * nothing stays mounted to play an exit; instead, once React has removed the
 * overlay's own elements, they go back where they were as a picture: the same
 * nodes, so a typed field, a scroll position and a canvas look exactly as they
 * did, but inert (out of the focus order and the accessibility tree), with no
 * role, and marked `data-leaving` for the stylesheet's exit animation, which
 * also turns the pointer away. They are removed when it ends.
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
        // The overlay's elements are siblings (a portal's), so they go back together.
        if (places.some(({ parent }) => parent !== places[0].parent)) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        // Marked while detached and put back in one insertion per parent, so
        // the picture costs the document as few mutations as it can: `inert`
        // already takes it out of the accessibility tree and the focus order,
        // and without its role nothing reads it as an open dialog.
        for (const { node } of places) {
          node.inert = true;
          node.removeAttribute("role");
          node.setAttribute("data-leaving", "");
        }
        const anchor = places.at(-1)!;
        const picture = document.createDocumentFragment();
        for (const { node } of places) picture.append(node);
        anchor.parent!.insertBefore(picture, anchor.next?.parentNode === anchor.parent ? anchor.next : null);
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
