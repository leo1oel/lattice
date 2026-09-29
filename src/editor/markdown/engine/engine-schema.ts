/**
 * The document schema of Lattice's visual Markdown engine: Tiptap's
 * CommonMark/GFM nodes (MIT), extended with the authored style each node needs
 * to write itself back the way it was written, plus Lattice's own nodes for
 * source that is shown and kept verbatim rather than interpreted.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Mark, Node, getSchema, type AnyExtension, type Attributes } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Image from "@tiptap/extension-image";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import Strike from "@tiptap/extension-strike";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import type { Schema } from "@tiptap/pm/model";


/** Attributes that only record how a node was written; never rendered, never semantic. */
const style = (defaults: Record<string, unknown>): Attributes => Object.fromEntries(
  Object.entries(defaults).map(([name, value]) => [name, { default: value, rendered: false }]),
);

/**
 * The same for marks, carried through the DOM as `data-lx-*` attributes:
 * ProseMirror re-reads typed text from the DOM, and a mark attribute the DOM
 * does not hold would read back as its default and look like an edit.
 */
const markStyle = (defaults: Record<string, string | null>): Attributes => Object.fromEntries(
  Object.entries(defaults).map(([name, value]) => [name, {
    default: value,
    parseHTML: (element: HTMLElement) => element.getAttribute(`data-lx-${name}`) ?? value,
    renderHTML: (attributes: Record<string, unknown>) => (
      attributes[name] == null || attributes[name] === value ? {} : { [`data-lx-${name}`]: String(attributes[name]) }
    ),
  }]),
);

/** How each Lattice node is recognized when HTML (a paste, a DOM re-read) is parsed back. */
const rawBlockSelector = "pre[data-lattice-raw]";
const rawInlineSelector = "span[data-lattice-raw-inline]";
const softBreakSelector = "br[data-lattice-soft]";
const inlineMathSelector = "span[data-lattice-math]";
const mathBlockSelector = "div[data-lattice-math-block]";
const componentSelector = "div[data-lattice-component]";
const footnoteReferenceSelector = "sup[data-lattice-footnote-ref]";
const footnoteSelector = "aside[data-lattice-footnote]";
const sourceTextSelector = "span[data-lattice-source]";

/** Style attribute names, dropped when two documents are compared for meaning. */
export const STYLE_ATTRIBUTES = new Set([
  "setext", "bullet", "delimiter", "incrementListMarker", "spread", "fence", "closeFence", "indented", "markup", "marker", "autolink",
  "source", "sourceKey", "html", "openTag", "closeTag", "inner", "propsKey", "bodyKey", "legacy", "layout", "colwidth",
]);

export type RawBlockKind =
  | "html" | "anchor" | "component" | "definition" | "frontmatter" | "unsupported";

/** A converter anchor line, `<a id="S3.F1"></a>`: an invisible scroll target. */
export const ANCHOR_SOURCE = /^<a\s+id=(?:"([^"]+)"|'([^']+)')\s*><\/a>$/;

/**
 * Markdown the engine keeps byte for byte: an HTML or MDX block, a link or
 * footnote definition, frontmatter, or any construct it does not model. Its
 * text is the source itself, so editing it is editing Markdown.
 */
export const RawBlock = Node.create<{ labels: Partial<Record<RawBlockKind, string>> }>({
  name: "latticeRawBlock",
  group: "block",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- ProseMirror content expression
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addOptions: () => ({ labels: {} }),
  addAttributes: () => ({ kind: { default: "unsupported", rendered: false } }),
  // Above the code block's generic `pre` rule, so a copied raw block pastes back as one.
  parseHTML: () => [{ tag: rawBlockSelector, priority: 60, preserveWhitespace: "full", getAttrs: (element) => ({ kind: element.getAttribute("data-lattice-raw") }) }],
  renderHTML({ node }) {
    const kind = node.attrs.kind as RawBlockKind;
    const anchor = kind === "anchor" ? node.textContent.match(ANCHOR_SOURCE) : null;
    const attributes = { class: "lx-md-raw", "data-lattice-raw": kind, "data-label": this.options.labels[kind] ?? kind, spellcheck: "false" };
    return ["pre", anchor ? { ...attributes, id: anchor[1] ?? anchor[2], "aria-hidden": "true" } : attributes, ["code", 0]];
  },
});

/** Inline source kept verbatim: inline HTML, references, and inline syntax the engine does not model. */
const RawInline = Node.create({
  name: "latticeRawInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ source: { default: "", rendered: false } }),
  parseHTML: () => [{ tag: rawInlineSelector, getAttrs: (element) => ({ source: element.textContent ?? "" }) }],
  renderHTML: ({ node }) => ["span", { class: "lx-md-raw-inline", "data-lattice-raw-inline": "", spellcheck: "false" }, String(node.attrs.source)],
  renderText: ({ node }) => String(node.attrs.source),
});

/**
 * A soft line break inside a paragraph. Shown where the author broke the line,
 * written back as a newline; distinct from a hard break, which Markdown renders.
 */
const SoftBreak = Node.create({
  name: "latticeSoftBreak",
  group: "inline",
  inline: true,
  selectable: false,
  parseHTML: () => [{ tag: softBreakSelector, priority: 60 }],
  renderHTML: () => ["br", { "data-lattice-soft": "" }],
  renderText: () => "\n",
});

/** Inline TeX. `source` is the authored delimiters and body, kept while `tex` is unchanged. */
export const InlineMath = Node.create({
  name: "latticeMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ tex: { default: "", rendered: false }, ...style({ source: null }) }),
  parseHTML: () => [{ tag: inlineMathSelector, getAttrs: (element) => ({ tex: element.getAttribute("data-tex") ?? "" }) }],
  renderHTML: ({ node }) => ["span", { class: "lx-md-math", "data-lattice-math": "", "data-tex": node.attrs.tex }, String(node.attrs.tex)],
  renderText: ({ node }) => `$${String(node.attrs.tex)}$`,
});

/**
 * A display formula (`$$…$$`, or `\[…\]` as authored). An atom: its TeX is an
 * attribute, edited in the formula popover, so moving or copying the block
 * carries the formula whole (R-BLK-4, R-RT-27).
 */
export const MathBlock = Node.create({
  name: "latticeMathBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({
    tex: { default: "", parseHTML: (element) => element.getAttribute("data-tex") ?? "", renderHTML: ({ tex }) => ({ "data-tex": tex }) },
    meta: { default: null, rendered: false },
    ...style({ source: null }),
  }),
  parseHTML: () => [{ tag: mathBlockSelector }],
  renderHTML: ({ HTMLAttributes, node }) => ["div", { ...HTMLAttributes, class: "lx-md-math-block", "data-lattice-math-block": "" }, String(node.attrs.tex)],
  renderText: ({ node }) => `$$\n${String(node.attrs.tex)}\n$$`,
});

/**
 * An MDX component Lattice renders: Callout, Accordion, and the converter's
 * paper figures (R-BLK-1, R-BLK-2, R-BLK-15). `props` are its properties in
 * source order; the style attributes record the exact opening and closing tags
 * and the exact body source, so a component written back unchanged keeps its
 * bytes, and one whose body did not change keeps the body's.
 */
export const Component = Node.create({
  name: "latticeComponent",
  group: "block",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- ProseMirror content expression
  content: "block*",
  defining: true,
  isolating: true,
  addAttributes: () => ({
    name: { default: "Callout", parseHTML: (element) => element.getAttribute("data-component") ?? "Callout", renderHTML: ({ name }) => ({ "data-component": name }) },
    props: {
      default: [],
      parseHTML: (element) => {
        try {
          return JSON.parse(element.getAttribute("data-props") ?? "[]") as unknown;
        } catch {
          return [];
        }
      },
      renderHTML: ({ props }) => ({ "data-props": JSON.stringify(props ?? []) }),
    },
    ...style({ openTag: null, closeTag: null, inner: null, propsKey: null, bodyKey: null, legacy: null }),
  }),
  parseHTML: () => [{ tag: componentSelector }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, class: "lx-md-component", "data-lattice-component": "" }, 0],
});

/** A footnote reference, `[^label]` (R-BLK-6). */
export const FootnoteReference = Node.create({
  name: "latticeFootnoteReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    label: { default: "", parseHTML: (element) => element.getAttribute("data-label") ?? "", renderHTML: ({ label }) => ({ "data-label": label }) },
  }),
  parseHTML: () => [{ tag: footnoteReferenceSelector }],
  renderHTML: ({ HTMLAttributes, node }) => ["sup", { ...HTMLAttributes, class: "lx-md-footnote-ref", "data-lattice-footnote-ref": "" }, `[${String(node.attrs.label)}]`],
  renderText: ({ node }) => `[^${String(node.attrs.label)}]`,
});

/** A footnote definition, `[^label]: …`, whose body is ordinary Markdown blocks (R-BLK-6, R-RT-20). */
export const FootnoteDefinition = Node.create({
  name: "latticeFootnote",
  group: "block",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- ProseMirror content expression
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes: () => ({
    label: { default: "", parseHTML: (element) => element.getAttribute("data-label") ?? "", renderHTML: ({ label }) => ({ "data-label": label }) },
  }),
  parseHTML: () => [{ tag: footnoteSelector }],
  renderHTML: ({ HTMLAttributes }) => ["aside", { ...HTMLAttributes, class: "lx-md-footnote", "data-lattice-footnote": "" }, 0],
});

/**
 * The authored spelling of a text run whose Markdown differs from its text —
 * escapes (`\_`), character references (`&amp;`). While the run still reads
 * `value`, the serializer writes `source`; once edited, the mark is stale and
 * the run is written from its text.
 */
const SourceText = Mark.create({
  name: "latticeSource",
  inclusive: false,
  excludes: "",
  addAttributes: () => ({
    source: { default: "", parseHTML: (element) => element.getAttribute("data-source") ?? "", renderHTML: ({ source }) => ({ "data-source": source }) },
    value: { default: "", parseHTML: (element) => element.getAttribute("data-value") ?? "", renderHTML: ({ value }) => ({ "data-value": value }) },
  }),
  parseHTML: () => [{ tag: sourceTextSelector }],
  renderHTML: ({ HTMLAttributes }) => ["span", { ...HTMLAttributes, "data-lattice-source": "" }, 0],
});

export type EngineSchemaOptions = { rawBlockLabels?: Partial<Record<RawBlockKind, string>> };

/** Tiptap extensions that define the engine's schema (node views are added by the editor). */
export function engineSchemaExtensions(options: EngineSchemaOptions = {}): AnyExtension[] {
  const kit = StarterKit.configure({
    // Lattice keeps history on the canonical Markdown document, not in ProseMirror.
    undoRedo: false,
    underline: false,
    trailingNode: false,
    heading: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    codeBlock: false,
    horizontalRule: false,
    hardBreak: false,
    bold: false,
    italic: false,
    strike: false,
    code: false,
    link: false,
  });
  return [
    kit,
    Heading.extend({ addAttributes() { return { ...this.parent?.(), ...style({ setext: false }) }; } }),
    HorizontalRule.extend({ addAttributes: () => style({ markup: null }) }),
    HardBreak.extend({ addAttributes: () => style({ markup: null }) }),
    ...listExtensions(),
    LatticeCodeBlock,
    ...markExtensions(),
    LatticeImage.configure({ inline: true, allowBase64: true }),
    Table.extend({ addAttributes: () => ({ align: { default: null, rendered: false }, ...style({ layout: null }) }) }).configure({ resizable: false }),
    TableRow,
    TableHeader.extend({ content: "paragraph" }),
    TableCell.extend({ content: "paragraph" }),
    RawBlock.configure({ labels: options.rawBlockLabels ?? {} }),
    RawInline,
    SoftBreak,
    InlineMath,
    MathBlock,
    Component,
    FootnoteReference,
    FootnoteDefinition,
    SourceText,
  ];
}

/**
 * Fenced and indented code (R-BLK-7). Enter only adds lines: there is no
 * triple-Enter exit. The style attributes record the fences as authored.
 */
export const LatticeCodeBlock = CodeBlock.extend({
  addAttributes() { return { ...this.parent?.(), meta: { default: null, rendered: false }, ...style({ fence: null, closeFence: null, indented: false }) }; },
  renderHTML: ({ node }) => {
    const language = node.attrs.language as string | null;
    return ["pre", language ? { "data-language": language } : {}, ["code", language ? { class: `language-${language}` } : {}, 0]];
  },
}).configure({ defaultLanguage: null, exitOnTripleEnter: false, enableTabIndentation: true, tabSize: 2 });

/**
 * Markdown and HTML images (R-BLK-3, R-FMT-7). `width` and `align` exist only
 * in the HTML form, which resizing or aligning switches to. `source` is the
 * image as authored, written back while the image still reads as it did
 * (`sourceKey`); `html` records which form it was written in.
 */
export const LatticeImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (element) => Number(element.getAttribute("width")) || null, renderHTML: ({ width }) => (width ? { width } : {}) },
      align: { default: null, parseHTML: (element) => element.getAttribute("data-align"), renderHTML: ({ align }) => (align ? { "data-align": align } : {}) },
      ...style({ source: null, sourceKey: null, html: false }),
    };
  },
});

function listExtensions(): AnyExtension[] {
  return [
    BulletList.extend({ addAttributes() { return { ...this.parent?.(), ...style({ bullet: "-", spread: false }) }; } }),
    OrderedList.extend({
      addAttributes() { return { ...this.parent?.(), ...style({ delimiter: ".", incrementListMarker: true, spread: false }) }; },
    }),
    ListItem.extend({ addAttributes() { return { ...this.parent?.(), ...style({ spread: false }) }; } }),
    TaskList.extend({ addAttributes() { return { ...this.parent?.(), ...style({ bullet: "-", spread: false }) }; } }),
    TaskItem.extend({ addAttributes() { return { ...this.parent?.(), ...style({ spread: false }) }; } }).configure({ nested: true }),
  ];
}

function markExtensions(): AnyExtension[] {
  const marker = (fallback: string) => ({ addAttributes: () => markStyle({ marker: fallback }) });
  return [
    Bold.extend(marker("**")),
    Italic.extend(marker("*")),
    Strike.extend(marker("~~")),
    // Markdown can wrap inline code in emphasis or a link, so code excludes nothing.
    Code.extend({ excludes: "" }),
    Link.extend({ addAttributes() { return { ...this.parent?.(), ...markStyle({ autolink: null }) }; } })
      .configure({ openOnClick: false, autolink: false, linkOnPaste: true }),
  ];
}

let cachedSchema: Schema | null = null;

/** The engine schema without an editor, for parsing and tests. */
export function engineSchema(): Schema {
  cachedSchema ??= getSchema(engineSchemaExtensions());
  return cachedSchema;
}
