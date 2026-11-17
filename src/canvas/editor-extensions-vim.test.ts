import { closeBrackets } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { afterEach, describe, expect, it } from "vitest";
import { baseEditorKeymap } from "../editor/editor-keymap";
import { latexEditorExtensions, type LatexEditorLiveData } from "../editor/latex/latex-editor";
import { loadVimKeymapExtensions } from "./editor-extensions";

const EMPTY_LIVE: LatexEditorLiveData = {
  citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [], localMacros: [],
  graphicsRoots: [], projectPaths: [], spellingWords: [],
};

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
});

/**
 * A LaTeX source editor in the order the app builds one: the host's base
 * setup (closeBrackets and the base keymap) ahead of the optional Vim keymap,
 * which is ahead of the LaTeX extensions.
 */
async function vimLatexView(doc: string, anchor: number): Promise<EditorView> {
  const vimExtensions: Extension[] = await loadVimKeymapExtensions(() => {});
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        closeBrackets(), keymap.of(baseEditorKeymap),
        ...vimExtensions,
        latexEditorExtensions({ live: { current: EMPTY_LIVE } }),
      ],
    }),
  });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const insertMode = (view: EditorView) => Boolean(getCM(view)?.state.vim?.insertMode);

describe("LaTeX editor with the Vim keymap", () => {
  it("moves to the end of the line on $ in normal mode instead of inserting math", async () => {
    const view = await vimLatexView("first line\nsecond", 2);
    expect(insertMode(view)).toBe(false);
    press(view, "$");
    expect(view.state.doc.toString()).toBe("first line\nsecond");
    // Vim's normal-mode cursor rests on the last character.
    expect(view.state.selection.main.head).toBe("first line".length - 1);
  });

  it("extends a visual selection to the end of the line on $", async () => {
    const view = await vimLatexView("first line\nsecond", 2);
    press(view, "v");
    press(view, "$");
    expect(view.state.doc.toString()).toBe("first line\nsecond");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("rst line");
  });

  it("leaves { and } to Vim's paragraph motions in normal mode", async () => {
    const view = await vimLatexView("\\section{A}\n\nnext\n", 9);
    press(view, "}");
    expect(view.state.doc.toString()).toBe("\\section{A}\n\nnext\n");
  });

  it("still pairs $ as math in insert mode", async () => {
    const view = await vimLatexView("x ", 2);
    press(view, "A");
    expect(insertMode(view)).toBe(true);
    press(view, "$");
    expect(view.state.doc.toString()).toBe("x $$");
    expect(view.state.selection.main.head).toBe(3);
    press(view, "Escape");
    expect(insertMode(view)).toBe(false);
  });
});
