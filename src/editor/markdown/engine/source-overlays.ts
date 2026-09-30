/**
 * What the visual engine paints from source coordinates (spec R-SRC-2,
 * R-SRC-3, R-SRC-6–8, R-SRC-11): collaborators' carets, comment highlights
 * and the comment being written, Overleaf's tracked changes, and the source
 * labels a split view scrolls by.
 *
 * The decorations are built from the source map whenever what they show, or
 * the Markdown they are placed in, changes (a publication, a load, new
 * comments or cursors); between those they follow ordinary edits. Anything
 * the map cannot place is not painted.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { hueColor } from "../../../components/ui/collab-colors";
import type { PresenceCursor } from "../../../overleaf/overleaf-editor-extensions";
import { presenceCursorColor } from "../../../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../../../overleaf/use-overleaf-realtime";
import { resolveCommentAnchor, type EditorComment } from "../../comments/editor-comment-data";
import { commentMarkStyle } from "../../comments/editor-comments";
import type { SourceMap } from "./source-map";

export type OverlayInputs = {
  cursors: readonly PresenceCursor[];
  comments: readonly EditorComment[];
  activeComment: string | null;
  changes: readonly TrackedChange[];
  /** Label every top-level block with its source line and range (split-view scroll sync). */
  labels: boolean;
};

type OverlayState = { decorations: DecorationSet; draft: { from: number; to: number } | null };

const sourceOverlaysKey = new PluginKey<OverlayState>("latticeSourceOverlays");

type OverlayMeta = { decorations?: DecorationSet; draft?: { from: number; to: number } | null };

/** The plugin that holds the overlays; `setOverlays` and `setCommentDraft` replace them. */
export const SourceOverlays = Extension.create({
  name: "latticeSourceOverlays",
  addProseMirrorPlugins: () => [new Plugin<OverlayState>({
    key: sourceOverlaysKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty, draft: null }),
      apply(transaction, state) {
        const meta = transaction.getMeta(sourceOverlaysKey) as OverlayMeta | undefined;
        let { decorations, draft } = state;
        if (transaction.docChanged) {
          decorations = decorations.map(transaction.mapping, transaction.doc);
          if (draft) {
            const from = transaction.mapping.map(draft.from, 1);
            const to = transaction.mapping.map(draft.to, -1);
            draft = to > from ? { from, to } : null;
          }
        }
        if (meta?.decorations) decorations = meta.decorations;
        if (meta && "draft" in meta) draft = meta.draft ?? null;
        return decorations === state.decorations && draft === state.draft ? state : { decorations, draft };
      },
    },
    props: {
      decorations(state) {
        const overlay = sourceOverlaysKey.getState(state);
        if (!overlay) return null;
        if (!overlay.draft) return overlay.decorations;
        return overlay.decorations.add(state.doc, [
          Decoration.inline(overlay.draft.from, overlay.draft.to, { class: "lx-md-comment-draft" }),
        ]);
      },
    },
  })],
});

export const setOverlays = (transaction: Transaction, decorations: DecorationSet) =>
  transaction.setMeta(sourceOverlaysKey, { decorations } satisfies OverlayMeta).setMeta("addToHistory", false);

export const setCommentDraft = (transaction: Transaction, draft: { from: number; to: number } | null) =>
  transaction.setMeta(sourceOverlaysKey, { draft } satisfies OverlayMeta).setMeta("addToHistory", false);

/** The id of the card that shows comment `id`'s thread. */
export const commentCardId = (id: string) => `lx-md-comment-card-${id}`;

export const commentDraft = (state: Parameters<typeof sourceOverlaysKey.getState>[0]) => sourceOverlaysKey.getState(state)?.draft ?? null;

/** Every overlay the inputs ask for, placed by `map` in `doc`. */
export function buildOverlays(doc: PmNode, map: SourceMap | null, inputs: OverlayInputs): DecorationSet {
  if (!map) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  if (inputs.labels) {
    for (const label of map.labels()) {
      const node = doc.nodeAt(label.pos);
      if (!node) continue;
      decorations.push(Decoration.node(label.pos, label.pos + node.nodeSize, {
        "data-source-line": String(label.line),
        "data-source-offset": String(label.from),
        "data-source-end-offset": String(label.to),
      }));
    }
  }
  for (const comment of inputs.comments) {
    if (comment.resolved) continue;
    const anchor = resolveCommentAnchor(map.text, comment);
    if (!anchor) continue;
    const from = map.offsetToPosition(anchor.from, "forward");
    const to = map.offsetToPosition(anchor.to, "backward");
    if (from == null || to == null || to <= from) continue;
    decorations.push(Decoration.inline(from, to, {
      class: comment.id === inputs.activeComment ? "lx-md-comment is-active" : "lx-md-comment",
      "data-lx-comment": comment.id,
      "aria-describedby": commentCardId(comment.id),
      style: commentMarkStyle(comment),
    }, { inclusiveStart: false, inclusiveEnd: false }));
  }
  for (const change of inputs.changes) {
    if (change.deletion) {
      const at = map.offsetToPosition(change.position);
      if (at == null) continue;
      decorations.push(Decoration.widget(at, () => changeWidget(change), { side: -1, key: `delete:${change.id}:${change.text}`, ignoreSelection: true }));
      continue;
    }
    const from = map.offsetToPosition(change.position, "forward");
    const to = map.offsetToPosition(change.position + change.text.length, "backward");
    if (from == null || to == null || to <= from) continue;
    decorations.push(Decoration.inline(from, to, {
      class: "lx-md-change is-insert",
      "data-lx-change": change.id,
      tabindex: "0",
      style: changeColors(change.hue),
    }, { inclusiveStart: false, inclusiveEnd: false }));
  }
  for (const [index, cursor] of inputs.cursors.entries()) {
    const at = map.rowColumnToPosition(cursor.row, cursor.column);
    if (at == null) continue;
    const color = presenceCursorColor(cursor);
    decorations.push(Decoration.widget(at, () => peerCaret(cursor.name, color), {
      side: 1,
      // A caret is drawn text, not a widget: never editable, never selected, never in the way of a click.
      raw: true,
      ignoreSelection: true,
      key: `peer:${index}:${cursor.name}:${color}`,
    }));
  }
  return DecorationSet.create(doc, decorations);
}

/** A suggestion is drawn in its author's Overleaf color. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS declaration
const changeColors = (hue: number) => `--lx-md-change-color: ${hueColor(hue)}; --lx-md-change-tint: ${hueColor(hue, 0.16)}`;

function peerCaret(name: string, color: string): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "lx-md-peer-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.style.setProperty("--lx-md-peer-color", color);
  const label = document.createElement("span");
  label.className = "lx-md-peer-caret-label";
  label.textContent = name;
  caret.append(label);
  return caret;
}

/** Text a suggestion would remove, shown at its place: it is not in the document. */
function changeWidget(change: TrackedChange): HTMLElement {
  const removed = document.createElement("span");
  removed.className = "lx-md-change is-delete";
  removed.dataset.lxChange = change.id;
  removed.tabIndex = 0;
  removed.setAttribute("style", changeColors(change.hue));
  removed.textContent = change.text;
  return removed;
}
