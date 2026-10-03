/**
 * Whether a jump's editor can be landed in yet. A document lives in a Trellis
 * tab: a tab behind another one stays laid out but hidden and inert, and the
 * canvas moving into a tab that is about to show (a comment opened from a
 * panel over it, a file switch) is shown a frame or more later. Until then the
 * browser refuses the editor focus, so typing after the jump goes nowhere.
 *
 * Kept free of editor dependencies: both the source editor (CodeMirror) and
 * the visual editor (ProseMirror) land jumps through it.
 */

/** How long a jump keeps asking for focus the browser refused. */
const FOCUS_WAIT_MS = 1000;

/** Whether `dom` is drawn and can take focus: connected, not in an inert subtree, not visibility-hidden. */
export function surfaceShown(dom: HTMLElement): boolean {
  return dom.isConnected && !dom.closest("[inert]") && dom.ownerDocument.defaultView?.getComputedStyle(dom).visibility !== "hidden";
}

/**
 * Focus an editor, and keep asking for a moment if the browser refuses: a jump
 * can land before its surface is shown (with reduced motion no transition
 * outlasts that). It stops once the writer moves focus anywhere but where it
 * was when the jump landed, or once `alive` reports the editor gone.
 */
export function focusWhenShown(editor: { dom: HTMLElement; focus(): void; hasFocus(): boolean; alive(): boolean }) {
  const page = editor.dom.ownerDocument;
  editor.focus();
  if (editor.hasFocus()) return;
  const left = page.activeElement;
  const deadline = performance.now() + FOCUS_WAIT_MS;
  const attempt = () => {
    if (!editor.alive() || performance.now() > deadline) return;
    const active = page.activeElement;
    if (active !== left && active !== page.body) return;
    editor.focus();
    if (!editor.hasFocus()) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
