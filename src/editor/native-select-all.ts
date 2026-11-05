import { selectAll } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

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
 *
 * WebKit reports the new selection (`selectionchange`) a task after the
 * command too, and a timer that came due meanwhile runs first. A transaction
 * it dispatches (a lint result, a collaborator's edit) can redraw, and a
 * redraw puts the editor's selection back into the DOM over one CodeMirror
 * has not read yet: the Select All is gone by the time the task looks, and
 * the next key types at the old caret. So the selection is also looked at in
 * the first update after `selectstart`, which plugins see before the redraw.
 */
class NativeSelectAll {
  /** The task that widens, from `selectstart` at the content element until it runs. */
  private pending: ReturnType<typeof setTimeout> | null = null;
  private selectedAll = false;

  constructor(private readonly view: EditorView) {}

  update() {
    this.look();
  }

  private look() {
    if (this.pending === null || this.selectedAll) return;
    const { contentDOM } = this.view;
    this.selectedAll = selectsEveryRenderedCharacter(contentDOM, contentDOM.ownerDocument.getSelection());
  }

  arm() {
    if (this.pending !== null) clearTimeout(this.pending);
    this.selectedAll = false;
    this.pending = setTimeout(() => {
      this.look();
      this.pending = null;
      if (!this.selectedAll || !this.view.contentDOM.isConnected || !this.view.hasFocus) return;
      selectAll(this.view);
    });
  }

  destroy() {
    if (this.pending !== null) clearTimeout(this.pending);
  }
}

export const nativeSelectAllSelectsDocument: Extension = ViewPlugin.fromClass(NativeSelectAll, {
  eventObservers: {
    selectstart(event, view) {
      if (event.target === view.contentDOM) this.arm();
    },
  },
});
