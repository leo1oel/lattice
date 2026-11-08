/**
 * Vim's `:w`, `:q` and `:wq`: save (and build), close the tab, or both.
 *
 * Vim keeps one ex-command table for every editor in the page, so the
 * commands are defined once on the library and reach whichever window
 * registered a runner (the command table, use-command-table.ts). `:w` is
 * the same Save as ⌘S, which builds what it saved; `:q` closes the tab, as
 * ⌘W does in the app window. This module stays free of the Vim library
 * itself: the command table is eager, and the library loads only when the
 * Vim keymap is chosen.
 */

/** What the ex commands ask for: the command table's Save (⌘S), and closing the editor's tab. */
export type VimExCommand = "save" | "quit";

type VimExRunner = (command: VimExCommand) => void;

/** The part of `@replit/codemirror-vim`'s `Vim` the commands need. */
export type VimExApi = { defineEx: (name: string, prefix: string | undefined, run: () => void) => void };

let runner: VimExRunner | null = null;

/** Lets the ex commands run `next`; returns what takes it back again. */
export function setVimExRunner(next: VimExRunner): () => void {
  runner = next;
  return () => {
    if (runner === next) runner = null;
  };
}

/**
 * Defines `:w`, `:q` and `:wq` on the library. Vim's own `:write` asks a
 * CodeMirror 5 save command nobody provides here, so it did nothing.
 * Defining again replaces, so every load of the keymap may call this.
 */
export function defineVimExCommands(vim: VimExApi): void {
  vim.defineEx("write", "w", () => runner?.("save"));
  vim.defineEx("quit", "q", () => runner?.("quit"));
  // Its own entry: `wq` is not a prefix of `write`, so `:wq` reached nothing.
  vim.defineEx("wq", "wq", () => {
    runner?.("save");
    runner?.("quit");
  });
}
