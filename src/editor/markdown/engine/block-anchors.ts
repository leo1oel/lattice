/**
 * The element ids the engine's views draw for links and jumps to land on:
 * footnotes and their references (R-BLK-6), converter anchors (R-RT-14) and
 * paper figures (R-BLK-15). The views read them from here, and so does a
 * block that is not drawn (block-window.ts), so a jump into a long document
 * finds its target before the block around it has ever been drawn. Heading
 * ids are planned over the whole document (heading-anchors.ts) and reach a
 * placeholder by decoration instead.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import { ANCHOR_SOURCE } from "./engine-schema";
import { propValue, type ComponentProp } from "./mdx-components";

const slug = (label: string) => label.toLowerCase().replace(/\s+/g, "-");
export const footnoteId = (label: string) => `fn-${slug(label)}`;
export const footnoteReferenceId = (label: string) => `fnref-${slug(label)}`;

/** The id a converter anchor (`<a id="…"></a>`) scrolls to. */
export function rawAnchorId(node: PmNode): string | undefined {
  const match = node.textContent.match(ANCHOR_SOURCE);
  return match?.[1] ?? match?.[2];
}

/** The id a paper figure or panel component draws (as ComponentView draws them by name). */
export function componentAnchorId(node: PmNode): string | undefined {
  switch (node.attrs.name) {
    case "Callout":
    case "Accordion":
    case "PaperFigureRow":
      return undefined;
    default: {
      const id = propValue((node.attrs.props ?? []) as ComponentProp[], "id");
      return typeof id === "string" ? id : undefined;
    }
  }
}

function anchorOf(node: PmNode): string | undefined {
  switch (node.type.name) {
    case "latticeFootnote":
      return footnoteId(String(node.attrs.label ?? ""));
    case "latticeFootnoteReference":
      return footnoteReferenceId(String(node.attrs.label ?? ""));
    case "latticeRawBlock":
      return node.attrs.kind === "anchor" ? rawAnchorId(node) : undefined;
    case "latticeComponent":
      return componentAnchorId(node);
    default:
      return undefined;
  }
}

/** Every id drawn inside a block, in document order. */
export function blockAnchors(block: PmNode): string[] {
  const ids: string[] = [];
  const visit = (node: PmNode) => {
    const id = anchorOf(node);
    if (id) ids.push(id);
    return true;
  };
  visit(block);
  block.descendants(visit);
  return ids;
}
