import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { defineVimExCommands, setVimExRunner, type VimExCommand } from "./vim-ex-commands";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

type VimEditor = Parameters<typeof Vim.handleEx>[0];

/** An editor with the Vim keymap on, as the source editor has it, ready for ex commands. */
function vimEditor(): VimEditor {
  const view = new EditorView({ doc: "\\section{Intro}\n", extensions: [vim({ status: false })], parent: document.body });
  views.push(view);
  const cm = getCM(view);
  if (!cm?.state.vim) throw new Error("Vim did not attach");
  return cm as VimEditor;
}

describe("Vim ex commands", () => {
  it("runs Save for :w, close the tab for :q, and both, in order, for :wq", () => {
    defineVimExCommands(Vim);
    const ran: VimExCommand[] = [];
    const release = setVimExRunner((command) => ran.push(command));
    const cm = vimEditor();

    Vim.handleEx(cm, "w");
    expect(ran).toEqual(["save"]);
    Vim.handleEx(cm, "write");
    Vim.handleEx(cm, "q");
    Vim.handleEx(cm, "quit");
    expect(ran).toEqual(["save", "save", "quit", "quit"]);
    ran.length = 0;
    Vim.handleEx(cm, "wq");
    expect(ran).toEqual(["save", "quit"]);
    release();
  });

  it("does nothing once the window that registered has let go", () => {
    defineVimExCommands(Vim);
    const ran: VimExCommand[] = [];
    const release = setVimExRunner((command) => ran.push(command));
    release();
    Vim.handleEx(vimEditor(), "w");
    expect(ran).toEqual([]);
  });

  it("keeps a newer runner when an older one lets go", () => {
    const first: VimExCommand[] = [];
    const second: VimExCommand[] = [];
    const releaseFirst = setVimExRunner((command) => first.push(command));
    const releaseSecond = setVimExRunner((command) => second.push(command));
    releaseFirst();
    defineVimExCommands(Vim);
    Vim.handleEx(vimEditor(), "w");
    expect(first).toEqual([]);
    expect(second).toEqual(["save"]);
    releaseSecond();
  });
});
