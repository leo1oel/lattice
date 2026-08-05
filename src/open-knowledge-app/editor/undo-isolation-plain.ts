/**
 * Local seam — not upstream code.
 *
 * Stands in for upstream editor/undo-isolation.ts, whose only job is to
 * split y-undo capture around a dispatch so linkify/math marks form their
 * own Y.UndoManager stack item. This host has no Yjs editor binding (the
 * canonical authority is the string-based CollabTextClientV2 path), so
 * upstream's own documented fallback applies verbatim: "Absent a y-undo
 * binding (non-collaborative editors) there is no capture stack and the
 * dispatch happens plain." Importing the real module would drag
 * @tiptap/y-tiptap + yjs into the bundle for a plugin key that never
 * resolves. The vendor script rewrites `from './undo-isolation'` here.
 */
import type { Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export function dispatchAsOwnUndoStep(view: EditorView, tr: Transaction): void {
  view.dispatch(tr);
}
