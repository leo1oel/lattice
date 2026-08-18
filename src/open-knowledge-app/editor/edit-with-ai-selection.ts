/**
 * Local seam — not upstream code.
 *
 * Upstream serializes the WYSIWYG selection to Markdown through its shared
 * markdown manager + clipboard serializer (deliberately not vendored — see
 * editor/clipboard/index.ts). This host owns a markdown manager with the
 * same serialize contract, so the seam reproduces upstream's behavior
 * (selection slice → doc JSON → serialized Markdown, trimmed) against it.
 */
import type { Editor } from "@tiptap/react";
import { getMarkdownManager } from "../../editor/markdown/visual-markdown-schema";

export function serializeWysiwygSelection(editor: Editor): string {
  const { state } = editor;
  try {
    const slice = state.selection.content();
    const content = slice.content.toJSON() as import("@tiptap/react").JSONContent[] | null;
    if (!content || content.length === 0) return "";
    return getMarkdownManager().serialize({ type: "doc", content }).trim();
  } catch {
    // Inline-open slices can produce non-doc-shaped JSON (upstream wraps them
    // via its clipboard serializer). Plain text is a faithful-enough prompt
    // payload for the shimmed Ask-AI / terminal sinks.
    return state.doc.textBetween(state.selection.from, state.selection.to, "\n").trim();
  }
}
