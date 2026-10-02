/**
 * Footnotes in the visual engine (spec R-BLK-6): a reference reads as its
 * bracketed label and jumps to the note; a definition is an editable note,
 * numbered in the order the document first refers to it, with a link back to
 * its reference. The number and the back link are chrome, outside native
 * selection; the note's text is ordinary editable Markdown.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the numbering plugin belongs with the views */
import { useLingui } from "@lingui/react/macro";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { CornerLeftUp } from "lucide-react";
import { footnoteId, footnoteReferenceId } from "../block-anchors";
import { drawnTarget } from "../block-window";
import { changedBlockRanges, containsAny, replacedAny } from "../changed-ranges";

function scrollToId(id: string, from: HTMLElement) {
  const found = from.ownerDocument.getElementById(id);
  if (!found) return;
  // A note far down a long document may not be drawn yet: draw it, then jump
  // there at once, since a smooth scroll would end where the undrawn note was.
  const target = drawnTarget(found);
  target.scrollIntoView({ block: "center", behavior: target === found ? "smooth" : "auto" });
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
    <NodeViewWrapper as="aside" className="lx-md-footnote" id={footnoteId(label)} aria-label={t`Footnote ${label}`}>
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

export const FootnoteNumbering = Extension.create({
  name: "latticeFootnoteNumbering",
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    key: numberingKey,
    state: {
      init: (_config, state) => numbering(state.doc),
      apply: (transaction, set) => (transaction.docChanged ? updateNumbering(set, transaction) : set),
    },
    props: { decorations: (state) => numberingKey.getState(state) },
  })],
});
