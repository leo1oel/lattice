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
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createHeadingSlugger } from "../heading-slug";
import { changedBlockRanges, replacedAny } from "./changed-ranges";

export type DocumentHeading = { pos: number; id: string; text: string; level: number; generatedContents: boolean };

// eslint-disable-next-line lingui/no-unlocalized-strings -- the heading the paper converter writes, not interface copy
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

/** What one node gets: its heading id, and whether it is a hidden part of a generated Contents. */
export type AnchorMark = { pos: number; id: string; hidden: boolean };

/** The anchor marks of a whole document: every heading's id, and a generated Contents heading and list hidden. */
export function anchorMarks(doc: PmNode, paper: boolean): AnchorMark[] {
  return anchorMarksOf(doc, documentHeadings(doc, paper));
}

function anchorMarksOf(doc: PmNode, headings: readonly DocumentHeading[]): AnchorMark[] {
  const marks: AnchorMark[] = [];
  for (const heading of headings) {
    marks.push({ pos: heading.pos, id: heading.id, hidden: heading.generatedContents });
    if (heading.generatedContents) marks.push({ pos: heading.pos + doc.nodeAt(heading.pos)!.nodeSize, id: "", hidden: true });
  }
  return marks;
}

/**
 * `marks` supplies a plan made elsewhere (a part of a larger document, whose
 * ids and hidden sections depend on what comes before it); by default the
 * document plans its own.
 */
type AnchorOptions = { paper: () => boolean; marks: ((doc: PmNode) => AnchorMark[]) | null };

type AnchorState = { decorations: DecorationSet; headings: DocumentHeading[] };

const anchorsKey = new PluginKey<AnchorState>("latticeHeadingAnchors");

function anchors(doc: PmNode, marks: readonly AnchorMark[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const mark of marks) {
    const node = doc.nodeAt(mark.pos);
    if (!node || (!mark.id && !mark.hidden)) continue;
    const attributes: Record<string, string> = mark.id ? { id: mark.id } : {};
    if (mark.hidden) Object.assign(attributes, { class: "lx-md-generated-contents", "aria-hidden": "true" });
    // `anchorId`: a block of a long document that is not drawn still carries a heading inside it (block-window.ts).
    decorations.push(Decoration.node(mark.pos, mark.pos + node.nodeSize, attributes, mark.id ? { anchorId: mark.id } : undefined));
  }
  return DecorationSet.create(doc, decorations);
}

/** Nodes whose edits can change the headings: headings themselves, and components that hold them. */
const HEADING_HOLDERS = new Set(["heading", "latticeComponent"]);

/** Whether a transaction could have changed a heading: it replaced or touched one, or a component. */
function touchesHeadings(transaction: Transaction): boolean {
  if (replacedAny(transaction, HEADING_HOLDERS)) return true;
  return changedBlockRanges(transaction).some((range) => {
    let found = false;
    transaction.doc.nodesBetween(range.from, range.to, (node) => {
      if (HEADING_HOLDERS.has(node.type.name)) found = true;
      return false;
    });
    return found;
  });
}

/** The document's headings as the anchors plugin last planned them (the section rail reads these). */
export const plannedHeadings = (state: EditorState): readonly DocumentHeading[] => anchorsKey.getState(state)?.headings ?? [];

/** Refresh the anchors after reading mode changes. */
export const REFRESH_ANCHORS = "latticeRefreshAnchors";

export const HeadingAnchors = Extension.create<AnchorOptions>({
  name: "latticeHeadingAnchors",
  addOptions: () => ({ paper: () => false, marks: null }),
  addProseMirrorPlugins() {
    const { paper, marks } = this.options;
    const plan = (doc: PmNode): AnchorState => {
      if (marks) return { decorations: anchors(doc, marks(doc)), headings: [] };
      const headings = documentHeadings(doc, paper());
      return { decorations: anchors(doc, anchorMarksOf(doc, headings)), headings };
    };
    return [new Plugin<AnchorState>({
      key: anchorsKey,
      state: {
        init: (_config, state) => plan(state.doc),
        apply: (transaction, current, _old, state) => {
          if (!transaction.docChanged && !transaction.getMeta(REFRESH_ANCHORS)) return current;
          // A keystroke in a paragraph moves the anchors without re-reading every heading (R-PERF-10).
          // In paper reading mode a list's shape decides the generated Contents, so it always re-reads.
          if (!transaction.getMeta(REFRESH_ANCHORS) && !paper() && !marks && !touchesHeadings(transaction)) {
            return { decorations: current.decorations.map(transaction.mapping, transaction.doc), headings: current.headings };
          }
          return plan(state.doc);
        },
      },
      props: { decorations: (state) => anchorsKey.getState(state)?.decorations },
    })];
  },
});
