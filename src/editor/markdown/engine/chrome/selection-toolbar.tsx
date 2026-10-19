/**
 * The selection toolbar (spec R-CHR-2, R-FMT-1, R-SRC-6, R-SRC-9, R-SRC-11):
 * a text selection shows the block type and the inline formats, portalled to
 * the body and hidden when the editor loses focus. Marks write `**…**`,
 * `*…*`, `<u>…</u>`, `~~…~~`, `` `…` `` and `==…==`; the selection can also
 * become a link, a footnote, or an inline formula, be commented on, or be
 * shown in the Markdown source. A read-only document offers only Comment.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useLayoutEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { FileCode, Link, MessageSquarePlus, Radical, Superscript } from "lucide-react";
import type { MarkdownBlockType } from "../../markdown-source-format";
import { useChromeRequest, type ChromeHost } from "./chrome-host";
import { requestLinkEditor } from "./link-chrome";
import { requestComment } from "./review-chrome";
import { insertFootnote } from "./slash-items";
import { popupMotionClassName } from "../../../../components/ui/popup-motion";
import { BlockTypeMenu, ToolbarButton, ToolbarDivider } from "./selection-toolbar-parts";
import { TOOLBAR_BLOCK_TYPES, TOOLBAR_MARKS } from "./selection-toolbar-items";

type BlockCommand = { active: (editor: Editor) => boolean; apply: (editor: Editor) => void };

const heading = (level: 1 | 2 | 3 | 4 | 5 | 6): BlockCommand => ({
  active: (editor) => editor.isActive("heading", { level }),
  apply: (editor) => {
    editor.chain().focus().setNode("heading", { level }).run();
  },
});

/** What each block type of the menu (selection-toolbar-parts.tsx) is in Tiptap (R-CHR-2). */
const BLOCK_COMMANDS: Record<MarkdownBlockType, BlockCommand> = {
  text: {
    active: (editor) => editor.isActive("paragraph") && !editor.isActive("bulletList") && !editor.isActive("orderedList") && !editor.isActive("taskList") && !editor.isActive("blockquote"),
    apply: (editor) => {
      editor.chain().focus().clearNodes().run();
    },
  },
  "heading-1": heading(1),
  "heading-2": heading(2),
  "heading-3": heading(3),
  "heading-4": heading(4),
  "heading-5": heading(5),
  "heading-6": heading(6),
  "bullet-list": { active: (editor) => editor.isActive("bulletList"), apply: (editor) => { editor.chain().focus().toggleBulletList().run(); } },
  "ordered-list": { active: (editor) => editor.isActive("orderedList"), apply: (editor) => { editor.chain().focus().toggleOrderedList().run(); } },
  "task-list": { active: (editor) => editor.isActive("taskList"), apply: (editor) => { editor.chain().focus().toggleTaskList().run(); } },
  quote: { active: (editor) => editor.isActive("blockquote"), apply: (editor) => { editor.chain().focus().toggleBlockquote().run(); } },
  "code-block": { active: (editor) => editor.isActive("codeBlock"), apply: (editor) => { editor.chain().focus().setCodeBlock().run(); } },
};

/** Replace the selection with an inline formula of its text (R-FMT-1). */
function convertToMath(editor: Editor) {
  const { from, to } = editor.state.selection;
  const tex = editor.state.doc.textBetween(from, to, " ");
  const transaction = editor.state.tr.replaceWith(from, to, editor.schema.nodes.latticeMath!.create({ tex }));
  transaction.setSelection(TextSelection.create(transaction.doc, from + 1));
  editor.view.dispatch(transaction);
}

/** Replace the selection with a footnote reference whose note holds the selected text (R-BLK-6). */
function convertToFootnote(editor: Editor) {
  const { from, to, $from } = editor.state.selection;
  const content = editor.state.doc.slice(from, to).content;
  const inline: import("@tiptap/pm/model").Node[] = [];
  content.descendants((node) => {
    if (node.isInline) {
      inline.push(node);
      return false;
    }
    return true;
  });
  if ($from.parent.inlineContent) insertFootnote(editor, { from, to }, inline);
}

function selectionShows(editor: Editor, host: ChromeHost): boolean {
  const { selection } = editor.state;
  if (selection.empty) return false;
  // Read-only, the toolbar exists only to comment, and the surface never takes focus.
  if (editor.isEditable ? !editor.view.hasFocus() : !host.props().onCreateComment) return false;
  if (selection instanceof NodeSelection || selection instanceof CellSelection) return false;
  if (editor.isEditable && selection.$from.parent.type.spec.code) return false;
  return !host.request || host.request.kind === "find";
}

/** Report where the selection starts in the Markdown, publishing a pending edit first (R-SRC-11). */
function viewInSource(editor: Editor, host: ChromeHost) {
  const map = host.sourceMap(true);
  if (!map) return;
  const { from } = editor.state.selection;
  // Where the selection start has no exact place (inside syntax), its block's start.
  const offset = map.positionToOffset(from) ?? map.blockRange(editor.state.doc.resolve(from).index(0))?.from;
  if (offset != null) host.props().onViewInSource?.(offset);
}

export function SelectionToolbar({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t, i18n } = useLingui();
  // The toolbar steps aside while the link editor it opened is showing.
  useChromeRequest(host);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      marks: TOOLBAR_MARKS.map(({ mark }) => current.isActive(mark)),
      block: TOOLBAR_BLOCK_TYPES.find((type) => BLOCK_COMMANDS[type.id].active(current))?.id ?? "text",
      link: current.isActive("link"),
    }),
  });
  // The toolbar floats in a layer of its own (outside the scrolling article so
  // it is never clipped). The menu decides it lost focus by whether focus left
  // that layer, so the block type menu mounts inside it too.
  const [layer] = useState(() => {
    const element = document.createElement("div");
    element.className = "lx-md-toolbar-layer";
    return element;
  });
  useLayoutEffect(() => {
    document.body.append(layer);
    return () => layer.remove();
  }, [layer]);
  const { onCreateComment, onViewInSource } = host.props();
  const editable = editor.isEditable;
  return (
    <BubbleMenu
      editor={editor}
      className={`lx-md-toolbar ${popupMotionClassName}`}
      role="toolbar"
      aria-label={t`Formatting`}
      appendTo={() => layer}
      updateDelay={0}
      shouldShow={({ editor: current }) => selectionShows(current as Editor, host)}
      options={{ placement: "top", offset: 8, flip: true }}
      data-side="top"
    >
      {editable && <><BlockTypeMenu active={state.block} container={layer} onSelect={(type) => BLOCK_COMMANDS[type].apply(editor)} />
      <ToolbarDivider />
      {TOOLBAR_MARKS.map(({ mark, label, icon: Icon }, index) => (
        <ToolbarButton key={mark} label={i18n._(label)} pressed={state.marks[index]} onPress={() => editor.chain().focus().toggleMark(mark).run()}>
          <Icon aria-hidden="true" />
        </ToolbarButton>
      ))}
      <ToolbarDivider />
      <ToolbarButton label={t`Insert link`} pressed={state.link} onPress={() => requestLinkEditor(editor, host)}>
        <Link aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label={t`Convert selection to footnote`} onPress={() => convertToFootnote(editor)}>
        <Superscript aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label={t`Convert selection to inline math`} onPress={() => convertToMath(editor)}>
        <Radical aria-hidden="true" />
      </ToolbarButton></>}
      {editable && (onCreateComment || onViewInSource) && <ToolbarDivider />}
      {onCreateComment && (
        <ToolbarButton label={t`Comment`} onPress={() => requestComment(host)}>
          <MessageSquarePlus aria-hidden="true" />
        </ToolbarButton>
      )}
      {editable && onViewInSource && (
        <ToolbarButton label={t`View in source Markdown`} onPress={() => viewInSource(editor, host)}>
          <FileCode aria-hidden="true" />
        </ToolbarButton>
      )}
    </BubbleMenu>
  );
}
