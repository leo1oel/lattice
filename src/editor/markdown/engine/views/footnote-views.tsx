/**
 * Footnotes in the visual engine (spec R-BLK-6): a reference reads as its
 * bracketed label and jumps to the note; a definition is an editable note,
 * numbered in the order the document first refers to it, with a link back to
 * its reference. The number and the back link are chrome, outside native
 * selection; the note's text is ordinary editable Markdown, and a click on
 * a note's chrome or beside it puts the caret in its text.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the numbering plugin belongs with the views */
import { useLingui } from "@lingui/react/macro";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { MouseEvent as ReactMouseEvent } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { CornerLeftUp } from "lucide-react";
import { footnoteId, footnoteReferenceId } from "../block-anchors";
import { scrollToTarget } from "../block-window";
import { changedBlockRanges, containsAny, replacedAny } from "../changed-ranges";

function scrollToId(id: string, from: HTMLElement) {
  const found = from.ownerDocument.getElementById(id);
  if (found) scrollToTarget(found, { block: "center", behavior: "smooth" });
}

export function FootnoteReferenceView(props: NodeViewProps) {
  const label = String(props.node.attrs.label ?? "");
  return (
    <NodeViewWrapper as="sup" className={`lx-md-footnote-ref${props.selected ? " is-selected" : ""}`}>
      <a
        id={footnoteReferenceId(label)}
        href={`#${footnoteId(label)}`}
        className="lx-md-footnote-ref-link"
        contentEditable={false}
        onClick={(event) => {
          event.preventDefault();
          scrollToId(footnoteId(label), event.currentTarget);
        }}
      >
        [{label}]
      </a>
    </NodeViewWrapper>
  );
}

export function FootnoteDefinitionView(props: NodeViewProps) {
  const { t } = useLingui();
  const label = String(props.node.attrs.label ?? "");
  return (
    <NodeViewWrapper
      as="aside"
      className="lx-md-footnote"
      id={footnoteId(label)}
      aria-label={t`Footnote ${label}`}
      // The node view keeps presses on the note's own box from the editor (they
      // reach pressOnNote below only from its chrome), so the box answers here.
      onMouseDown={(event: ReactMouseEvent) => {
        if (!event.defaultPrevented) pressOnNote(props.editor.view, event.nativeEvent);
      }}
    >
      <span className="lx-md-footnote-number" contentEditable={false} aria-hidden="true" />
      <NodeViewContent className="lx-md-footnote-body" />
      <a
        className="lx-md-footnote-backref"
        href={`#${footnoteReferenceId(label)}`}
        contentEditable={false}
        aria-label={t`Back to reference`}
        onClick={(event) => {
          event.preventDefault();
          scrollToId(footnoteReferenceId(label), event.currentTarget);
        }}
      >
        <CornerLeftUp aria-hidden="true" />
      </a>
    </NodeViewWrapper>
  );
}

/** Footnote numbers, by first reference; notes never referred to follow in document order. */
function numbering(doc: PmNode): DecorationSet {
  const order = new Map<string, number>();
  const definitions: { label: string; from: number; to: number }[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === "latticeFootnoteReference") {
      const key = String(node.attrs.label).toLowerCase();
      if (!order.has(key)) order.set(key, order.size + 1);
    } else if (node.type.name === "latticeFootnote") {
      definitions.push({ label: String(node.attrs.label).toLowerCase(), from: position, to: position + node.nodeSize });
    }
    return node.type.name !== "latticeFootnote" && !node.isTextblock;
  });
  for (const definition of definitions) {
    if (!order.has(definition.label)) order.set(definition.label, order.size + 1);
  }
  return DecorationSet.create(doc, definitions.map((definition) => (
    // The number reaches the view's chrome as a custom property the stylesheet prints.
    Decoration.node(definition.from, definition.to, { style: `--lx-md-footnote-number: "${order.get(definition.label)}"` })
  )));
}

const numberingKey = new PluginKey<DecorationSet>("latticeFootnoteNumbers");
const FOOTNOTE_NODES = new Set(["latticeFootnoteReference", "latticeFootnote"]);

/** Numbers change only when an edit adds, removes or changes a reference or a note. */
function updateNumbering(set: DecorationSet, transaction: Transaction): DecorationSet {
  const touched = replacedAny(transaction, FOOTNOTE_NODES)
    || containsAny(transaction.doc, changedBlockRanges(transaction), FOOTNOTE_NODES);
  return touched ? numbering(transaction.doc) : set.map(transaction.mapping, transaction.doc);
}

/**
 * A click beside a note (below the last one, in the surface's tall bottom
 * padding, or in the margin between two) lands between blocks, where the gap
 * cursor would put its horizontal bar. The reader was aiming at the note's
 * text: the caret goes to the end of the note above, else the start of the
 * note below. A paragraph after the notes is one Add block below away.
 */
function caretBesideNote(view: EditorView, position: number): boolean {
  const $at = view.state.doc.resolve(position);
  if ($at.depth !== 0) return false;
  const { nodeBefore: before, nodeAfter: after } = $at;
  const direction = before?.type.name === "latticeFootnote" ? -1
    : after?.type.name === "latticeFootnote" && !before?.isTextblock ? 1 : 0;
  const caret = direction ? TextSelection.findFrom($at, direction, true) : null;
  if (!caret) return false;
  view.dispatch(view.state.tr.setSelection(caret));
  return true;
}

/**
 * A press on a note's own margin (its number, the space under the rule above
 * it, the gutter beside its text) is not on editable text, so WebKit would put
 * the caret at the next editable text: the following note. It lands on this
 * note's text at the pressed height instead.
 */
function pressOnNote(view: EditorView, event: MouseEvent): boolean {
  const target = event.target as Element | null;
  const note = target?.closest?.(".lx-md-footnote");
  if (event.button !== 0 || event.shiftKey || !note || !view.dom.contains(note)) return false;
  if (target!.closest(".lx-md-footnote-body, .lx-md-footnote-backref")) return false;
  const body = note.querySelector(".lx-md-footnote-body");
  if (!body) return false;
  const rect = body.getBoundingClientRect();
  const rtl = getComputedStyle(body).direction === "rtl";
  // Probed well inside the first or last line: right at the body's edge WebKit can answer with the next note.
  const inset = Math.min(8, rect.height / 2);
  const top = Math.min(Math.max(event.clientY, rect.top + inset), rect.bottom - inset);
  const found = view.posAtCoords({ left: rtl ? rect.right - 1 : rect.left + 1, top });
  if (!found) return false;
  event.preventDefault();
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(found.pos))));
  return true;
}

export const FootnoteNumbering = Extension.create({
  name: "latticeFootnoteNumbering",
  // Ahead of the starter kit's gap cursor (100), whose click handler would take the click first.
  priority: 101,
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    key: numberingKey,
    state: {
      init: (_config, state) => numbering(state.doc),
      apply: (transaction, set) => (transaction.docChanged ? updateNumbering(set, transaction) : set),
    },
    props: {
      decorations: (state) => numberingKey.getState(state),
      handleClick: (view, position) => caretBesideNote(view, position),
      handleDOMEvents: { mousedown: (view, event) => pressOnNote(view, event) },
    },
  })],
});
