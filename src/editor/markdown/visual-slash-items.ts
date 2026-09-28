/** The visual editor's slash menu: upstream items, localized and adapted to project assets. */
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Editor } from "@tiptap/react";
import { getComponentItems, getInlineComponentItems } from "@ok-app/editor/slash-command/component-items";
import { getEmbedStarterItems } from "@ok-app/editor/slash-command/embed-starter-items";
import { getSlashCommandItems, type SlashCommandContext, type SlashCommandItem } from "@ok-app/editor/slash-command/items";
import { projectAssetMarkdownHref } from "./markdown-link-routing";

export const VISUAL_LINK_INSERT_EVENT = "research-writer:visual-link-insert";

/** Open the link editor (visual-link-insert-popover) for the editor's current selection. */
export function openVisualLinkInsert(editor: Editor) {
  window.dispatchEvent(new CustomEvent(VISUAL_LINK_INSERT_EVENT, { detail: { editor } }));
}

/**
 * The vendored editor is compiled through an English-only Lingui seam, so its
 * slash items cannot see Lattice's active catalog. Keep the host translation
 * at this composition boundary rather than patching generated vendor files.
 */
const SLASH_ITEM_MESSAGES: Record<string, [label: MessageDescriptor, description: MessageDescriptor]> = {
  heading1: [msg`Heading 1`, msg`Big section heading.`],
  heading2: [msg`Heading 2`, msg`Medium section heading.`],
  heading3: [msg`Heading 3`, msg`Small section heading.`],
  heading4: [msg`Heading 4`, msg`Fourth-level heading.`],
  heading5: [msg`Heading 5`, msg`Fifth-level heading.`],
  heading6: [msg`Heading 6`, msg`Sixth-level heading.`],
  bulletList: [msg`Bullet List`, msg`Unordered list of items.`],
  orderedList: [msg`Ordered List`, msg`Numbered list of items.`],
  taskList: [msg`Task List`, msg`Checklist with checkboxes.`],
  blockquote: [msg`Quote`, msg`Indented blockquote for citations.`],
  codeBlock: [msg`Code Block`, msg`Fenced code block with monospace text.`],
  table: [msg`Table`, msg`Grid of rows and columns with a header row.`],
  separator: [msg`Separator`, msg`Horizontal rule that divides sections.`],
  footnote: [msg`Footnote`, msg`Insert a footnote reference + matching definition stub.`],
  emoji: [msg`Emoji`, msg`Pick an emoji to insert at the cursor.`],
  inlineMath: [msg`Inline Math`, msg`Inline LaTeX math rendered with KaTeX.`],
  link: [msg`Link`, msg`Link to a page or external URL.`],
  "component-Callout": [msg`Callout`, msg`Highlight tips, warnings, and notes.`],
  "component-Accordion": [msg`Accordion`, msg`Collapsible section with a clickable summary.`],
  "component-Toggle": [msg`Toggle`, msg`Collapsible content block (Notion-style toggle).`],
  "component-Tabs": [msg`Tabs`, msg`Horizontal pill strip + active panel below; click a pill to switch panels.`],
  "component-Math": [msg`Math`, msg`Block math equation rendered with KaTeX from a LaTeX source string.`],
  "component-MermaidFence": [
    msg`Mermaid`,
    msg`Diagram from Mermaid source — flowchart, sequence, class, state, ER, gantt, pie.`,
  ],
  "component-Mirror": [
    msg`Mirror`,
    msg`Read-only copy of a MirrorSource block from another doc. Edit at the source and it updates live.`,
  ],
  "component-MirrorSource": [
    msg`Mirror Source`,
    msg`Mark a block as the source of truth. Mirrors elsewhere update live as you edit it.`,
  ],
  "component-HtmlAlignBlock": [msg`Align block`, msg`Align a group of blocks to the left, center, or right.`],
  "component-img": [msg`Image`, msg`Embed an image with optional alt text.`],
  "embed-starter-html": [msg`HTML`, msg`Custom HTML with a live preview pane (sandboxed iframe).`],
};

const SLASH_CATEGORY_MESSAGES: Record<string, MessageDescriptor> = {
  basic: msg`Basic blocks`,
  insert: msg`Insert`,
  content: msg`Components`,
  layout: msg`Layout`,
  media: msg`Media`,
  data: msg`Data`,
  embed: msg`Embeds`,
};

const UNSUPPORTED_COMPONENTS = ["component-video", "component-audio", "component-Pdf", "component-Embed", "component-File"];

function localizeSlashItem(item: SlashCommandItem, i18n: I18n): SlashCommandItem {
  const messages = SLASH_ITEM_MESSAGES[item.name];
  if (!messages) return item;
  const description = i18n._(messages[1]);
  return {
    ...item,
    label: i18n._(messages[0]),
    description,
    preview: item.preview ? { ...item.preview, description } : undefined,
  };
}

export function slashCategoryLabels(i18n: I18n): Record<string, string> {
  return Object.fromEntries(Object.entries(SLASH_CATEGORY_MESSAGES).map(([category, message]) => [category, i18n._(message)]));
}

function pickAndImportImage(
  { editor, state }: SlashCommandContext,
  importAsset: (file: File) => Promise<string | null>,
  getActivePath: () => string,
) {
  // `state` is the chainable post-trigger-delete state. Reading editor.state
  // here would capture the old `/image` cursor position, which is out of range
  // by the time the async project import finishes.
  const position = state.selection.from;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.setAttribute("aria-label", "Choose image to upload");
  input.hidden = true;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void importAsset(file).then((path) => {
      if (path) editor.commands.insertContentAt(position, {
        type: "jsxComponent",
        attrs: {
          componentName: "img",
          kind: "element",
          props: { src: projectAssetMarkdownHref(getActivePath(), path) },
          sourceDirty: true,
        },
      });
    });
    input.remove();
  }, { once: true });
  document.body.appendChild(input);
  input.click();
}

function insertLinkPlaceholder({ chain, state, editor, afterCommit }: SlashCommandContext) {
  const from = state.selection.from;
  chain().insertContent({
    type: "text",
    text: "link",
    marks: [{ type: "link", attrs: { href: "" } }],
  }).setTextSelection({ from, to: from + 4 }).run();
  afterCommit(() => openVisualLinkInsert(editor));
}

/** Upstream slash-menu composition minus app-only skill references, cached per locale. */
export function slashItemSources(
  i18n: I18n,
  importAsset: ((file: File) => Promise<string | null>) | undefined,
  getActivePath: () => string,
) {
  const cached = (factory: () => SlashCommandItem[]) => {
    const itemsByLocale = new Map<string, SlashCommandItem[]>();
    return () => {
      let items = itemsByLocale.get(i18n.locale);
      if (!items) {
        items = factory().map((item) => localizeSlashItem(item, i18n));
        itemsByLocale.set(i18n.locale, items);
      }
      return items;
    };
  };
  return [
    cached(getSlashCommandItems),
    cached(() => getComponentItems()
      .filter((item) => !UNSUPPORTED_COMPONENTS.includes(item.name))
      .map((item) => item.label !== "Image" || !importAsset ? item : {
        ...item,
        command: (context: SlashCommandContext) => pickAndImportImage(context, importAsset, getActivePath),
      })),
    cached(() => getEmbedStarterItems()
      .filter((item) => item.name === "embed-starter-html")
      .map((item) => ({ ...item, category: "media" }))),
    cached(() => getInlineComponentItems().map((item) => item.name !== "link" ? item : {
      ...item,
      command: insertLinkPlaceholder,
    })),
  ];
}
