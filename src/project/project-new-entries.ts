import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/** What the Project panel's + menu (and its ⋯ menu) can create. */
export type NewEntryType = "latex" | "markdown" | "folder" | "spreadsheet" | "board" | "presentation";

/** A creation the tree is asked to start; every request carries a new `serial`. */
export type NewEntryRequest = { type: NewEntryType; serial: number };

/**
 * The menu's order: what a paper is written in first, then, past a separator,
 * the other canvases a project can hold.
 */
export const NEW_ENTRIES: readonly { type: NewEntryType; label: MessageDescriptor; separated?: boolean }[] = [
  { type: "latex", label: msg`New LaTeX file` },
  { type: "markdown", label: msg`New Markdown file` },
  { type: "folder", label: msg`New folder` },
  { type: "spreadsheet", label: msg`New spreadsheet`, separated: true },
  { type: "board", label: msg`New board` },
  { type: "presentation", label: msg`New presentation` },
];
