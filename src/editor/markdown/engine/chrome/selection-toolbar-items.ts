/**
 * The selection toolbar's block types and inline formats, in order, shared by
 * the visual editor's toolbar and the Markdown source editor's. Each toolbar
 * maps the ids to its own commands.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Bold, Code, Highlighter, Italic, Strikethrough, Underline } from "lucide-react";
import type { MarkdownBlockType } from "../../markdown-source-format";

/** The twelve block types, in three separated groups after Text (R-CHR-2). */
export const TOOLBAR_BLOCK_TYPES: readonly { id: MarkdownBlockType; label: MessageDescriptor; separated?: boolean }[] = [
  { id: "text", label: msg`Text` },
  { id: "heading-1", label: msg`Heading 1`, separated: true },
  { id: "heading-2", label: msg`Heading 2` },
  { id: "heading-3", label: msg`Heading 3` },
  { id: "heading-4", label: msg`Heading 4` },
  { id: "heading-5", label: msg`Heading 5` },
  { id: "heading-6", label: msg`Heading 6` },
  { id: "bullet-list", label: msg`Bullet List`, separated: true },
  { id: "ordered-list", label: msg`Ordered List` },
  { id: "task-list", label: msg`Task List` },
  { id: "quote", label: msg`Quote`, separated: true },
  { id: "code-block", label: msg`Code Block` },
];

/** The inline formats, with their marks. */
export const TOOLBAR_MARKS = [
  { mark: "bold", label: msg`Bold`, icon: Bold },
  { mark: "italic", label: msg`Italic`, icon: Italic },
  { mark: "underline", label: msg`Underline`, icon: Underline },
  { mark: "strike", label: msg`Strikethrough`, icon: Strikethrough },
  { mark: "code", label: msg`Inline code`, icon: Code },
  { mark: "highlight", label: msg`Highlight`, icon: Highlighter },
] as const;
