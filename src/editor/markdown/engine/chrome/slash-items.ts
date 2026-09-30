/**
 * The slash menu's items (spec R-CHR-1, §12): the Markdown-native blocks and
 * the kept components, in the order Lattice has always listed them, grouped
 * as Basic blocks, Insert, Components and Media. The dropped features (Toggle,
 * Tabs, Mirror, Mirror source, Align block, the HTML live-preview starter) are
 * not offered; files that contain them keep them as source.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Editor, Range } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Image, Link, List, ListCollapse, ListOrdered, ListTodo, Minus,
  MessageSquareWarning, Quote, Radical, Smile, SquareCode, SquareSigma, Superscript, Table, Workflow, type LucideIcon,
} from "lucide-react";
import { ACCORDION, CALLOUT } from "../mdx-components";
import type { ChromeHost } from "./chrome-host";

export type SlashItem = {
  id: string;
  group: MessageDescriptor;
  label: MessageDescriptor;
  description: MessageDescriptor;
  /** Extra search terms, in English, beside the localized label. */
  keywords: string[];
  icon: LucideIcon;
  run: (editor: Editor, range: Range, host: ChromeHost) => void;
};

const BASIC = msg`Basic blocks`;
const INSERT = msg`Insert`;
const COMPONENTS = msg`Components`;
const MEDIA = msg`Media`;

/** Replace the slash query with `node`: in place of the paragraph when it is now empty, else after it. */
function insertBlock(editor: Editor, range: Range, node: PmNode, select: "inside" | "node" | "after" = "inside") {
  const transaction = editor.state.tr.delete(range.from, range.to);
  const $at = transaction.doc.resolve(range.from);
  const paragraph = $at.parent;
  let position: number;
  if (paragraph.type.name === "paragraph" && paragraph.content.size === 0 && $at.depth > 0) {
    position = $at.before();
    transaction.replaceWith(position, $at.after(), node);
  } else {
    position = $at.depth > 0 ? $at.after() : $at.pos;
    transaction.insert(position, node);
  }
  if (select === "node") transaction.setSelection(NodeSelection.create(transaction.doc, position));
  else if (select === "inside") transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 1)));
  else transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + node.nodeSize)));
  editor.view.dispatch(transaction.scrollIntoView());
  editor.view.focus();
}

/** Replace the slash query with an inline node and select it. */
function insertInline(editor: Editor, range: Range, node: PmNode) {
  const transaction = editor.state.tr.replaceWith(range.from, range.to, node);
  transaction.setSelection(NodeSelection.create(transaction.doc, range.from));
  editor.view.dispatch(transaction.scrollIntoView());
  editor.view.focus();
}

const heading = (level: number, label: MessageDescriptor, description: MessageDescriptor, icon: LucideIcon): SlashItem => ({
  id: `heading-${level}`,
  group: BASIC,
  label,
  description,
  keywords: [`h${level}`, "heading", "title"],
  icon,
  run: (editor, range) => {
    editor.chain().focus().deleteRange(range).setNode("heading", { level }).run();
  },
});

/** The next footnote label not yet used in the document: 1, 2, … */
function nextFootnoteLabel(doc: PmNode): string {
  const used = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "latticeFootnote" || node.type.name === "latticeFootnoteReference") used.add(String(node.attrs.label));
  });
  let label = 1;
  while (used.has(String(label))) label += 1;
  return String(label);
}

/**
 * A footnote reference at the caret and its definition at the end of the
 * document, with the caret in the definition to write the note (R-BLK-6).
 * `note` fills the definition (Convert selection to footnote).
 */
export function insertFootnote(editor: Editor, range: Range, note?: PmNode[]) {
  const { schema } = editor.state;
  const label = nextFootnoteLabel(editor.state.doc);
  const transaction = editor.state.tr.replaceWith(range.from, range.to, schema.nodes.latticeFootnoteReference!.create({ label }));
  const paragraph = schema.nodes.paragraph!.create(null, note?.length ? note : undefined);
  const definition = schema.nodes.latticeFootnote!.create({ label }, paragraph);
  const end = transaction.doc.content.size;
  transaction.insert(end, definition);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(end + 2 + paragraph.content.size)));
  editor.view.dispatch(transaction.scrollIntoView());
  editor.view.focus();
}

const SLASH_ITEMS: readonly SlashItem[] = [
  heading(1, msg`Heading 1`, msg`Big section heading.`, Heading1),
  heading(2, msg`Heading 2`, msg`Medium section heading.`, Heading2),
  heading(3, msg`Heading 3`, msg`Small section heading.`, Heading3),
  heading(4, msg`Heading 4`, msg`Fourth-level heading.`, Heading4),
  heading(5, msg`Heading 5`, msg`Fifth-level heading.`, Heading5),
  heading(6, msg`Heading 6`, msg`Sixth-level heading.`, Heading6),
  {
    id: "bullet-list",
    group: BASIC,
    label: msg`Bullet List`,
    description: msg`Unordered list of items.`,
    keywords: ["ul", "unordered", "bullet", "list"],
    icon: List,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: "ordered-list",
    group: BASIC,
    label: msg`Ordered List`,
    description: msg`Numbered list of items.`,
    keywords: ["ol", "numbered", "ordered", "list"],
    icon: ListOrdered,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: "task-list",
    group: BASIC,
    label: msg`Task List`,
    description: msg`Checklist with checkboxes.`,
    keywords: ["todo", "task", "checkbox", "checklist"],
    icon: ListTodo,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: "quote",
    group: BASIC,
    label: msg`Quote`,
    description: msg`Indented blockquote for citations.`,
    keywords: ["blockquote", "quote"],
    icon: Quote,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: "code-block",
    group: BASIC,
    label: msg`Code Block`,
    description: msg`Fenced code block with monospace text.`,
    keywords: ["code", "fence", "snippet"],
    icon: SquareCode,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setCodeBlock().run();
    },
  },
  {
    id: "table",
    group: BASIC,
    label: msg`Table`,
    description: msg`Grid of rows and columns with a header row.`,
    keywords: ["table", "grid"],
    icon: Table,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    },
  },
  {
    id: "separator",
    group: BASIC,
    label: msg`Separator`,
    description: msg`Horizontal rule that divides sections.`,
    keywords: ["hr", "divider", "rule", "separator"],
    icon: Minus,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
  {
    id: "footnote",
    group: INSERT,
    label: msg`Footnote`,
    description: msg`Insert a footnote reference + matching definition stub.`,
    keywords: ["footnote", "note", "reference"],
    icon: Superscript,
    run: (editor, range) => insertFootnote(editor, range),
  },
  {
    id: "emoji",
    group: INSERT,
    label: msg`Emoji`,
    description: msg`Pick an emoji to insert at the cursor.`,
    keywords: ["emoji", "smiley"],
    icon: Smile,
    run: (editor, range, host) => {
      editor.chain().focus().deleteRange(range).run();
      host.ask({ kind: "emoji", at: range.from });
    },
  },
  {
    id: "inline-math",
    group: INSERT,
    label: msg`Inline Math`,
    description: msg`Inline LaTeX math rendered with KaTeX.`,
    keywords: ["math", "latex", "formula", "equation", "katex"],
    icon: Radical,
    run: (editor, range) => insertInline(editor, range, editor.schema.nodes.latticeMath!.create({ tex: "" })),
  },
  {
    id: "link",
    group: INSERT,
    label: msg`Link`,
    description: msg`Link to a page or external URL.`,
    keywords: ["link", "url", "href"],
    icon: Link,
    run: (editor, range, host) => {
      // Placeholder text, selected, with the URL field open (R-FMT-4).
      const text = "link";
      const transaction = editor.state.tr.replaceWith(range.from, range.to, editor.schema.text(text, [editor.schema.marks.link!.create({ href: "" })]));
      transaction.setSelection(TextSelection.create(transaction.doc, range.from, range.from + text.length));
      editor.view.dispatch(transaction);
      editor.view.focus();
      host.ask({ kind: "link", from: range.from, to: range.from + text.length });
    },
  },
  {
    id: "callout",
    group: COMPONENTS,
    label: msg`Callout`,
    description: msg`Highlight tips, warnings, and notes.`,
    keywords: ["callout", "note", "tip", "warning", "admonition"],
    icon: MessageSquareWarning,
    run: (editor, range) => insertBlock(editor, range, editor.schema.nodes.latticeComponent!.create({
      name: CALLOUT,
      props: [
        { name: "type", kind: "string", value: "note" },
        { name: "collapsible", kind: "boolean", value: false },
        { name: "defaultOpen", kind: "boolean", value: true },
      ],
    }, editor.schema.nodes.paragraph!.create())),
  },
  {
    id: "accordion",
    group: COMPONENTS,
    label: msg`Accordion`,
    description: msg`Collapsible section with a clickable summary.`,
    keywords: ["accordion", "details", "collapse", "disclosure"],
    icon: ListCollapse,
    run: (editor, range) => insertBlock(editor, range, editor.schema.nodes.latticeComponent!.create({
      name: ACCORDION,
      props: [{ name: "defaultOpen", kind: "boolean", value: true }],
    }, editor.schema.nodes.paragraph!.create())),
  },
  {
    id: "math",
    group: COMPONENTS,
    label: msg`Math`,
    description: msg`Block math equation rendered with KaTeX from a LaTeX source string.`,
    keywords: ["math", "latex", "equation", "formula", "display", "katex"],
    icon: SquareSigma,
    run: (editor, range) => insertBlock(editor, range, editor.schema.nodes.latticeMathBlock!.create({ tex: "" }), "node"),
  },
  {
    id: "mermaid",
    group: COMPONENTS,
    label: msg`Mermaid`,
    description: msg`Diagram from Mermaid source — flowchart, sequence, class, state, ER, gantt, pie.`,
    keywords: ["mermaid", "diagram", "flowchart", "chart"],
    icon: Workflow,
    run: (editor, range) => insertBlock(
      editor,
      range,
      // eslint-disable-next-line lingui/no-unlocalized-strings -- Mermaid source written into the document
      editor.schema.nodes.codeBlock!.create({ language: "mermaid" }, editor.schema.text("flowchart LR\n  A --> B")),
      "after",
    ),
  },
  {
    id: "image",
    group: MEDIA,
    label: msg`Image`,
    description: msg`Embed an image with optional alt text.`,
    keywords: ["image", "picture", "photo", "figure", "img"],
    icon: Image,
    run: (editor, range, host) => {
      if (host.props().onImportAsset) {
        editor.chain().focus().deleteRange(range).run();
        host.ask({ kind: "image", at: range.from });
        return;
      }
      // Without an importer the image is written empty, with no prompt (R-FMT-3).
      insertInline(editor, range, editor.schema.nodes.image!.create({ src: "", html: true }));
    },
  },
];

/** Items whose localized label, English keywords or id contain every word of `query`. */
export function matchSlashItems(query: string, label: (item: SlashItem) => string): SlashItem[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter((item) => {
    const haystack = `${label(item)} ${item.keywords.join(" ")} ${item.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
