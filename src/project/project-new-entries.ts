import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/** What the Project panel's + menu (and its ⋯ menu) can add: a new entry, or files imported from the Mac. */
export type NewEntryType = "latex" | "markdown" | "folder" | "import" | "spreadsheet" | "board" | "presentation";

/** A creation (or import) the tree is asked to start; every request carries a new `serial`. */
export type NewEntryRequest = { type: NewEntryType; serial: number };

/**
 * The menu's order: what a paper is written in first, and existing files
 * brought in beside them, then, past a separator, the other canvases a
 * project can hold.
 */
/** The panel's ⋯ menu, the tree's context menus and the palette all offer it. */
export const REFRESH_FILE_TREE = msg`Refresh file tree`;

export const NEW_ENTRIES: readonly { type: NewEntryType; label: MessageDescriptor; separated?: boolean }[] = [
  { type: "latex", label: msg`New LaTeX file` },
  { type: "markdown", label: msg`New Markdown file` },
  { type: "folder", label: msg`New folder` },
  { type: "import", label: msg`Import files…` },
  { type: "spreadsheet", label: msg`New spreadsheet`, separated: true },
  { type: "board", label: msg`New board` },
  { type: "presentation", label: msg`New presentation` },
];
