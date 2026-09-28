/**
 * Overlays painted from source coordinates: collaborator carets, Overleaf
 * tracked changes, and editor comments. Each is a decoration plugin that
 * rebuilds from a published snapshot of the source text and maps its
 * decorations through ordinary document edits in between.
 */
import { msg } from "@lingui/core/macro";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { i18n } from "../../i18n";
import { peerColorForKey } from "../../components/ui/collab-colors";
import { presenceCursorColor, type PresenceCursor } from "../../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../../overleaf/use-overleaf-realtime";
import { resolveCommentAnchor, type EditorComment } from "../comments/editor-comment-data";
import { element } from "../dom-utils";
import {
  proseMirrorPositionForSourceOffset,
  proseMirrorRangeForSource,
  sourceOffsetForRowColumn,
} from "./visual-source-map";

type PmDoc = Editor["state"]["doc"];
type SourceSnapshot = { text: string; sourcePath: string };

function sourceDecorationLayer<Meta extends SourceSnapshot>(
  name: string,
  build: (doc: PmDoc, meta: Meta) => Decoration[],
) {
  const key = new PluginKey<DecorationSet>(name);
  return {
    extension: Extension.create({
      name,
      addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (transaction, decorations, _oldState, { doc }) => {
            const meta = transaction.getMeta(key) as Meta | undefined;
            if (meta) return DecorationSet.create(doc, build(doc, meta));
            return transaction.docChanged ? decorations.map(transaction.mapping, doc) : decorations;
          },
        },
        props: { decorations: (state) => key.getState(state) ?? null },
      })],
    }),
    publish: (editor: Editor, meta: Meta) => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, meta));
    },
  };
}

function presenceCaret(name: string, color: string): HTMLElement {
  const caret = element("span", "visual-overleaf-caret");
  caret.setAttribute("aria-hidden", "true");
  caret.style.borderColor = color;
  const dot = element("span", "visual-overleaf-caret-dot");
  const label = element("span", "visual-overleaf-caret-label", name || i18n._(msg`Anonymous`));
  dot.style.backgroundColor = label.style.backgroundColor = color;
  caret.append(dot, label);
  return caret;
}

export const visualPresence = sourceDecorationLayer<SourceSnapshot & { cursors: PresenceCursor[] }>(
  "visualOverleafPresence",
  (doc, { text, sourcePath, cursors }) => cursors.flatMap((cursor) => {
    const position = proseMirrorPositionForSourceOffset(
      doc,
      text,
      sourceOffsetForRowColumn(text, cursor.row, cursor.column),
      sourcePath,
    );
    const color = presenceCursorColor(cursor);
    return position === null ? [] : [Decoration.widget(position, () => presenceCaret(cursor.name, color), {
      side: 1,
      // A coordinate-bearing key keeps ProseMirror from reusing the old widget
      // DOM after the collaborator's caret moves. Keep the default selection
      // handling: ignoring DOM selections inside the widget makes WebKit unable
      // to place a local caret in the same cell.
      key: `${cursor.name}:${color}:${cursor.row}:${cursor.column}`,
      // ProseMirror normally turns widget roots into contenteditable=false
      // islands, and WebKit then treats the containing table cell as
      // unclickable when this zero-width widget is its caret hit target. The
      // widget is visual-only and ignores pointers, so keep it editable DOM.
      raw: true,
      stopEvent: () => false,
    })];
  }),
);

export const trackedChangeLabel = (change: TrackedChange) => (
  i18n._(change.deletion ? msg`Suggested deletion` : msg`Suggested insertion`)
);
export const trackedChangeColor = (change: TrackedChange) => `hsl(${change.hue}, 70%, 50%)`;
export const trackedChangeTint = (change: TrackedChange) => (
  `hsl(${change.hue} 70% 50% / ${change.deletion ? 0.1 : 0.14})`
);

export const visualTrackChanges = sourceDecorationLayer<SourceSnapshot & { changes: TrackedChange[] }>(
  "visualOverleafTrackChanges",
  (doc, { text, sourcePath, changes }) => changes.flatMap((change) => {
    const attributes = {
      class: `visual-tracked-change visual-tracked-change-${change.deletion ? "delete" : "insert"}`,
      "data-visual-change-id": change.id,
      "aria-controls": "visual-tracked-change-tooltip",
      "aria-haspopup": "dialog",
      "aria-label": trackedChangeLabel(change),
      role: "button",
      tabindex: "0",
      style: `--visual-change-color: ${trackedChangeColor(change)}; --visual-change-tint: ${trackedChangeTint(change)}`,
    };
    if (change.deletion) {
      const from = proseMirrorPositionForSourceOffset(doc, text, change.position, sourcePath);
      return from === null ? [] : [Decoration.widget(from, () => {
        const deleted = element("span", "", change.text);
        for (const [name, value] of Object.entries(attributes)) deleted.setAttribute(name, value);
        deleted.contentEditable = "false";
        return deleted;
      }, { side: -1, key: `deletion:${change.id}:${change.position}:${change.text}` })];
    }
    const end = change.position + change.text.length;
    const range = proseMirrorRangeForSource(doc, text, { from: change.position, to: end }, sourcePath);
    return range && text.slice(change.position, end) === change.text
      ? [Decoration.inline(range.from, range.to, attributes)]
      : [];
  }),
);

export type CommentDraftAnchor = Pick<EditorComment, "path" | "from" | "to" | "quote" | "prefix" | "suffix">;

/**
 * Comment highlights for the preview. Comments are anchored to source offsets:
 * resolve the anchor in the source, then ask where it lands in the parsed
 * document. A comment whose quote no longer resolves (edited away, or inside
 * syntax the preview does not render as text) is simply not painted.
 */
export const visualComments = sourceDecorationLayer<SourceSnapshot & {
  comments: EditorComment[];
  draft: CommentDraftAnchor | null;
  activeId: string | null;
  tooltipId: string;
  labelForAuthor: (authorName: string) => string;
}>("visualEditorComments", (doc, { text, sourcePath, comments, draft, activeId, tooltipId, labelForAuthor }) => {
  const rangeOf = (anchor: Parameters<typeof resolveCommentAnchor>[1]) => {
    const resolved = resolveCommentAnchor(text, anchor);
    return resolved ? proseMirrorRangeForSource(doc, text, resolved, sourcePath) : null;
  };
  const decorations = comments.flatMap((comment) => {
    const range = comment.resolved ? null : rangeOf(comment);
    if (!range) return [];
    // Same per-author colour the source editor uses, so both surfaces read as one feature.
    const colors = peerColorForKey(comment.authorId || comment.authorName);
    return [Decoration.inline(range.from, range.to, {
      class: `visual-editor-comment${comment.id === activeId ? " visual-editor-comment-active" : ""}`,
      "data-visual-comment-id": comment.id,
      role: "button",
      tabindex: "0",
      "aria-describedby": tooltipId,
      "aria-label": labelForAuthor(comment.authorName),
      style: `--visual-comment-tint: ${colors.colorLight}; --visual-comment-color: ${colors.color}`,
    })];
  });
  const draftRange = draft?.path === sourcePath ? rangeOf(draft) : null;
  return draftRange
    ? [...decorations, Decoration.inline(draftRange.from, draftRange.to, { class: "editor-comment-draft" })]
    : decorations;
});
