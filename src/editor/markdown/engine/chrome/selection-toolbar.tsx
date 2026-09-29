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
import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold, Check, ChevronDown, Code, FileCode, Highlighter, Italic, Link, MessageSquarePlus, Radical, Strikethrough, Superscript, Underline,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu";
import type { ChromeHost } from "./chrome-host";
import { requestLinkEditor } from "./link-chrome";
import { requestComment } from "./review-chrome";
import { insertFootnote } from "./slash-items";

type BlockType = {
  id: string;
  label: MessageDescriptor;
  /** Separator before this entry. */
  separated?: boolean;
  active: (editor: Editor) => boolean;
  apply: (editor: Editor) => void;
};

const heading = (level: 1 | 2 | 3 | 4 | 5 | 6, label: MessageDescriptor): BlockType => ({
  id: `heading-${level}`,
  label,
  separated: level === 1,
  active: (editor) => editor.isActive("heading", { level }),
  apply: (editor) => {
    editor.chain().focus().setNode("heading", { level }).run();
  },
});

/** The twelve block types, in three separated groups after Text (R-CHR-2). */
const BLOCK_TYPES: readonly BlockType[] = [
  {
    id: "text",
    label: msg`Text`,
    active: (editor) => editor.isActive("paragraph") && !editor.isActive("bulletList") && !editor.isActive("orderedList") && !editor.isActive("taskList") && !editor.isActive("blockquote"),
    apply: (editor) => {
      editor.chain().focus().clearNodes().run();
    },
  },
  heading(1, msg`Heading 1`),
  heading(2, msg`Heading 2`),
  heading(3, msg`Heading 3`),
  heading(4, msg`Heading 4`),
  heading(5, msg`Heading 5`),
  heading(6, msg`Heading 6`),
  { id: "bullet-list", label: msg`Bullet List`, separated: true, active: (editor) => editor.isActive("bulletList"), apply: (editor) => { editor.chain().focus().toggleBulletList().run(); } },
  { id: "ordered-list", label: msg`Ordered List`, active: (editor) => editor.isActive("orderedList"), apply: (editor) => { editor.chain().focus().toggleOrderedList().run(); } },
  { id: "task-list", label: msg`Task List`, active: (editor) => editor.isActive("taskList"), apply: (editor) => { editor.chain().focus().toggleTaskList().run(); } },
  { id: "quote", label: msg`Quote`, separated: true, active: (editor) => editor.isActive("blockquote"), apply: (editor) => { editor.chain().focus().toggleBlockquote().run(); } },
  { id: "code-block", label: msg`Code Block`, active: (editor) => editor.isActive("codeBlock"), apply: (editor) => { editor.chain().focus().setCodeBlock().run(); } },
];

/** The inline formats, with their marks. */
const MARKS = [
  { mark: "bold", label: msg`Bold`, icon: Bold },
  { mark: "italic", label: msg`Italic`, icon: Italic },
  { mark: "underline", label: msg`Underline`, icon: Underline },
  { mark: "strike", label: msg`Strikethrough`, icon: Strikethrough },
  { mark: "code", label: msg`Inline code`, icon: Code },
  { mark: "highlight", label: msg`Highlight`, icon: Highlighter },
] as const;

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
  useSyncExternalStore(host.subscribe, () => host.request, () => host.request);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      marks: MARKS.map(({ mark }) => current.isActive(mark)),
      block: BLOCK_TYPES.find((type) => type.active(current))?.id ?? "text",
      link: current.isActive("link"),
    }),
  });
  const block = BLOCK_TYPES.find((type) => type.id === state.block) ?? BLOCK_TYPES[0]!;
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
      className="lx-md-toolbar"
      role="toolbar"
      aria-label={t`Formatting`}
      appendTo={() => layer}
      updateDelay={0}
      shouldShow={({ editor: current }) => selectionShows(current as Editor, host)}
      options={{ placement: "top", offset: 8, flip: true }}
    >
      {editable && <><DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="lx-md-toolbar-block" aria-label={t`Block type`} onMouseDown={(event) => event.preventDefault()}>
            <span>{i18n._(block.label)}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent container={layer} align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
          {BLOCK_TYPES.map((type) => (
            <BlockTypeItem key={type.id} separated={type.separated} active={type.id === block.id} onSelect={() => type.apply(editor)}>
              {i18n._(type.label)}
            </BlockTypeItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="lx-md-toolbar-divider" aria-hidden="true" />
      {MARKS.map(({ mark, label, icon: Icon }, index) => (
        <ToolbarButton key={mark} label={i18n._(label)} pressed={state.marks[index]} onPress={() => editor.chain().focus().toggleMark(mark).run()}>
          <Icon aria-hidden="true" />
        </ToolbarButton>
      ))}
      <span className="lx-md-toolbar-divider" aria-hidden="true" />
      <ToolbarButton label={t`Insert link`} pressed={state.link} onPress={() => requestLinkEditor(editor, host)}>
        <Link aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label={t`Convert selection to footnote`} onPress={() => convertToFootnote(editor)}>
        <Superscript aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label={t`Convert selection to inline math`} onPress={() => convertToMath(editor)}>
        <Radical aria-hidden="true" />
      </ToolbarButton></>}
      {editable && (onCreateComment || onViewInSource) && <span className="lx-md-toolbar-divider" aria-hidden="true" />}
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

/** A toolbar action; pressing it never takes focus or the selection from the editor. */
function ToolbarButton({ label, pressed, onPress, children }: { label: string; pressed?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button type="button" className="lx-md-toolbar-button" aria-label={label} title={label} aria-pressed={pressed} onMouseDown={(event) => event.preventDefault()} onClick={onPress}>
      {children}
    </button>
  );
}

function BlockTypeItem({ separated, active, onSelect, children }: { separated?: boolean; active: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <>
      {separated && <DropdownMenuSeparator />}
      <DropdownMenuItem data-active={active || undefined} onSelect={onSelect}>
        <span className="lx-md-toolbar-check" aria-hidden="true">{active && <Check />}</span>
        {children}
      </DropdownMenuItem>
    </>
  );
}
