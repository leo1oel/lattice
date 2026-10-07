import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/* eslint-disable lingui/no-unlocalized-strings -- ProseMirror key names */

/**
 * The visual Markdown editor's keys, as the shortcut sheet lists them. The
 * engine's own keymaps (links, block moves, leaving a code block) bind theirs
 * from here; the formatting keys are TipTap's, and engine-shortcuts.test
 * checks this table against what the engine's extensions bind. Find is the
 * chrome's (findShortcuts), which reads read-only documents too.
 */
export const ENGINE_SHORTCUTS = {
  bold: { keys: ["Mod-b"], label: msg`Bold` },
  italic: { keys: ["Mod-i"], label: msg`Italic` },
  underline: { keys: ["Mod-u"], label: msg`Underline` },
  strike: { keys: ["Mod-Shift-s"], label: msg`Strikethrough` },
  code: { keys: ["Mod-e"], label: msg`Inline code` },
  link: { keys: ["Mod-k"], label: msg`Add or edit a link` },
  paragraph: { keys: ["Mod-Alt-0"], label: msg`Body text` },
  heading: { keys: ["Mod-Alt-1", "Mod-Alt-2", "Mod-Alt-3", "Mod-Alt-4", "Mod-Alt-5", "Mod-Alt-6"], label: msg`Heading 1 to 6` },
  bulletList: { keys: ["Mod-Shift-8"], label: msg`Bulleted list` },
  orderedList: { keys: ["Mod-Shift-7"], label: msg`Numbered list` },
  taskList: { keys: ["Mod-Shift-9"], label: msg`Task list` },
  blockquote: { keys: ["Mod-Shift-b"], label: msg`Quote` },
  codeBlock: { keys: ["Mod-Alt-c"], label: msg`Code block` },
  leaveCodeBlock: { keys: ["Mod-Enter"], label: msg`Leave a code block` },
  moveBlock: { keys: ["Mod-Shift-ArrowUp", "Mod-Shift-ArrowDown"], label: msg`Move the block up or down` },
  find: { keys: ["Mod-f"], label: msg`Find in document` },
  replace: { keys: ["Mod-Alt-f"], label: msg`Find and replace` },
} satisfies Record<string, { keys: string[]; label: MessageDescriptor }>;
