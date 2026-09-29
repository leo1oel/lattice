/**
 * Headings as places to go (spec R-BLK-13, R-BLK-14): every heading gets the
 * id its slug gives (duplicates suffixed in document order), so fragment
 * links, wiki links and the section rail land on it; and in paper reading
 * mode the converter's generated "Contents" section is hidden from view
 * (still in the Markdown, still in the document, out of the rail).
 *
 * Headings count where a Markdown reader would find them by line: at the top
 * level and inside components, not inside quotes or lists.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createHeadingSlugger } from "../heading-slug";

export type DocumentHeading = { pos: number; id: string; text: string; level: number; generatedContents: boolean };

const CONTENTS_TITLE = "Contents";

/** Whether the list after a "Contents" heading is the converter's: every entry one link to a heading on the page. */
function isGeneratedContentsList(node: PmNode | null | undefined): boolean {
  if (!node || (node.type.name !== "bulletList" && node.type.name !== "orderedList") || !node.childCount) return false;
  let generated = true;
  node.forEach((item) => {
    const paragraph = item.firstChild;
    let links = 0;
    let plain = false;
    paragraph?.forEach((inline) => {
      const link = inline.marks.find((mark) => mark.type.name === "link");
      if (link && String(link.attrs.href).startsWith("#")) links += 1;
      else if (inline.isText && inline.text?.trim()) plain = true;
    });
    // The converter links each entry that names a real heading and leaves the rest as plain text.
    if (item.childCount !== 1 || (!links && !plain)) generated = false;
  });
  return generated;
}

/** The document's headings in order, with their ids; `paper` marks a generated Contents section. */
export function documentHeadings(doc: PmNode, paper: boolean): DocumentHeading[] {
  const slug = createHeadingSlugger();
  const headings: DocumentHeading[] = [];
  const visit = (parent: PmNode, base: number) => {
    parent.forEach((child, offset, index) => {
      const pos = base + offset;
      if (child.type.name === "heading") {
        const text = child.textContent;
        const generatedContents = paper && parent === doc && child.attrs.level === 2 && text.trim() === CONTENTS_TITLE
          && isGeneratedContentsList(parent.maybeChild(index + 1));
        headings.push({ pos, id: slug(text), text, level: child.attrs.level as number, generatedContents });
      } else if (child.type.name === "latticeComponent") {
        visit(child, pos + 1);
      }
    });
  };
  visit(doc, 0);
  return headings;
}

type AnchorOptions = { paper: () => boolean };

const anchorsKey = new PluginKey<DecorationSet>("latticeHeadingAnchors");

function anchors(doc: PmNode, paper: boolean): DecorationSet {
  const decorations: Decoration[] = [];
  for (const heading of documentHeadings(doc, paper)) {
    const node = doc.nodeAt(heading.pos)!;
    if (heading.generatedContents) {
      const hidden = { class: "lx-md-generated-contents", "aria-hidden": "true" };
      decorations.push(Decoration.node(heading.pos, heading.pos + node.nodeSize, heading.id ? { ...hidden, id: heading.id } : hidden));
      const list = doc.nodeAt(heading.pos + node.nodeSize);
      if (list) decorations.push(Decoration.node(heading.pos + node.nodeSize, heading.pos + node.nodeSize + list.nodeSize, hidden));
    } else if (heading.id) {
      decorations.push(Decoration.node(heading.pos, heading.pos + node.nodeSize, { id: heading.id }));
    }
  }
  return DecorationSet.create(doc, decorations);
}

/** Refresh the anchors after reading mode changes. */
export const REFRESH_ANCHORS = "latticeRefreshAnchors";

export const HeadingAnchors = Extension.create<AnchorOptions>({
  name: "latticeHeadingAnchors",
  addOptions: () => ({ paper: () => false }),
  addProseMirrorPlugins() {
    const { paper } = this.options;
    return [new Plugin<DecorationSet>({
      key: anchorsKey,
      state: {
        init: (_config, state) => anchors(state.doc, paper()),
        apply: (transaction, set, _old, state) => (transaction.docChanged || transaction.getMeta(REFRESH_ANCHORS) ? anchors(state.doc, paper()) : set),
      },
      props: { decorations: (state) => anchorsKey.getState(state) },
    })];
  },
});
