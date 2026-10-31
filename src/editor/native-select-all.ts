import { selectAll } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Whether the DOM selection reaches from before the first rendered character
 * of `content` to after its last one. CodeMirror renders only the lines near
 * the viewport (and the selection's), so this is "everything on the page",
 * not the document. A document with no rendered text (blank lines only)
 * counts any non-empty selection.
 */
function selectsEveryRenderedCharacter(content: HTMLElement, selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const walker = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let first: Text | null = null;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || node.length === 0) continue;
    first ??= node;
    last = node;
  }
  if (!first || !last) return true;
  return range.comparePoint(first, 0) === 0 && range.comparePoint(last, last.length) === 0;
}

/**
 * Edit › Select All (the native menu's `selectAll:`, and anything else that
 * runs the browser's SelectAll command, `execCommand("selectAll")` included)
 * selects the whole document: it runs the command ⌘A is bound to.
 *
 * ⌘A reaches CodeMirror's keymap, which selects the document itself. The menu
 * item sends `selectAll:` to the web view instead, and the browser selects
 * the editor's DOM, which holds only the rendered lines: in a long file,
 * copying, deleting or pasting over that selection touches only the lines on
 * screen. CodeMirror widens such a selection to the document in iOS and
 * Chrome (`browser.ios || browser.chrome` in @codemirror/view's DOMChange),
 * but not in macOS WebKit, the engine Lattice runs in.
 *
 * The browser fires `selectstart` at the editable root (the content element)
 * just before it selects all of it; a selection started by the pointer fires
 * it at the node under the pointer instead, and CodeMirror prevents the
 * default of the presses it handles anyway. The selection lands after the
 * event (synchronously within the same command), and a microtask is too
 * early when the native menu runs the command with no script on the stack,
 * so the check waits a task. Only a selection that reaches across every
 * rendered character is widened, so a `selectstart` that turns out to be
 * something else (a context click on the editor's padding) changes nothing.
 */
export const nativeSelectAllSelectsDocument: Extension = EditorView.domEventObservers({
  selectstart(event, view) {
    if (event.target !== view.contentDOM) return;
    setTimeout(() => {
      if (!view.contentDOM.isConnected || !view.hasFocus) return;
      if (!selectsEveryRenderedCharacter(view.contentDOM, view.contentDOM.ownerDocument.getSelection())) return;
      selectAll(view);
    });
  },
});
