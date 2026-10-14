/**
 * Keyboard focus draws the ring; focus a pointer caused does not.
 *
 * `:focus-visible` alone cannot tell the two apart here, because most focus
 * moves are made by script: a Radix menu focuses the item under the moving
 * pointer and hands focus back to its trigger as it closes, a Select returns
 * to its trigger after a click picks a value, a dialog returns focus to its
 * opener, and Trellis focuses a panel a frame after a click. For script focus
 * WebKit and Chromium both guess from the focus before it, and a menu opened
 * by a click leaves nothing to guess from (Radix opens on pointerdown and
 * cancels the trigger's own focus), so its items and then the trigger matched
 * `:focus-visible` and drew the blue ring under the mouse.
 *
 * Whichever hand moved last decides instead: an element that takes focus
 * while the pointer moved last is marked `data-pointer-focus`, and the ring
 * rules (styles/app-shell.css, the project tree's sheet) skip a marked
 * element. Any key press hands focus back to the keyboard, so Tab after a
 * click still draws the ring, and Escape out of a menu rings the trigger it
 * returns to. The mark sits on the focused element alone, never on the root,
 * so a change of hands restyles one element, not the document.
 */
const MARK = "data-pointer-focus";

let pointerMovedLast = false;
let installed = false;

/**
 * The element that gained or lost focus, inside an open shadow root (the
 * project tree) too. Editable text is left alone: it never takes the ring, and
 * the editors watch their own content element's attributes.
 */
function focusTarget(event: FocusEvent): Element | null {
  const target = event.composedPath()[0];
  if (!(target instanceof Element)) return null;
  return target instanceof HTMLElement && target.isContentEditable ? null : target;
}

export function installPointerFocus() {
  if (installed) return;
  installed = true;
  const pointer = () => {
    pointerMovedLast = true;
  };
  window.addEventListener("pointerdown", pointer, { capture: true, passive: true });
  // Moving, not only pressing: a menu focuses the row the pointer moves onto.
  window.addEventListener("pointermove", pointer, { capture: true, passive: true });
  window.addEventListener("keydown", () => {
    pointerMovedLast = false;
  }, true);
  const watched = new WeakSet<Node>();
  const watch = (root: Document | ShadowRoot) => {
    watched.add(root);
    root.addEventListener("focusin", (event) => {
      const target = focusTarget(event as FocusEvent);
      if (!target) return;
      if (pointerMovedLast) target.setAttribute(MARK, "");
      else target.removeAttribute(MARK);
      // Focus moving from one element to another inside the same shadow root
      // (row to row in the project tree) never reaches the document: the
      // event stops where its target and related target retarget to the same
      // host. Focus has to enter the root from outside first, which the
      // document does see, so the root is watched from then on.
      const root = target.getRootNode();
      if (root instanceof ShadowRoot && !watched.has(root)) watch(root);
    }, true);
    root.addEventListener("focusout", (event) => {
      focusTarget(event as FocusEvent)?.removeAttribute(MARK);
    }, true);
  };
  watch(document);
}
