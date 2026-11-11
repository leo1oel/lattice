/**
 * Visual mode and Overleaf sync: what a linked project sends is the text's
 * changes as OT operations (`OtDocument.local`), so switching to Visual and
 * moving through it must send nothing, and the same typing in Visual must
 * send exactly the operations it sends in Source.
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OtDocument, type OtOp } from "../../../overleaf/ot";
import { baseEditorKeymap } from "../../editor-keymap";
import { pointerSelection } from "../../pointer-selection";
import { latexEditorExtensions, type LatexEditorLiveData } from "../latex-editor";
import { latex } from "../latex-language";
import { isLatexVisual, latexVisualSlot, type LatexVisualHost } from "../latex-visual-switch";
import { chooseLatexView } from "../latex-view-choice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

const LIVE: LatexEditorLiveData = {
  citationKeys: ["knuth"], citations: [], references: [], unusedLabels: [], unusedCitations: [], localMacros: [],
  graphicsRoots: [], projectPaths: [], spellingWords: [], katexMacros: {},
};
const HOST: LatexVisualHost = { data: () => LIVE, loadImage: async () => null, open: () => {} };

const DOC = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\section{Method}",
  "We set \\textbf{bold words} beside $E = mc^2$ and cite \\cite{knuth}.",
  "",
  "\\begin{itemize}",
  "  \\item first point",
  "  \\item second point",
  "\\end{itemize}",
  "\\begin{equation}\\label{eq:one}",
  "  a + b = c",
  "\\end{equation}",
  "\\end{document}",
  "",
].join("\n");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  localStorage.clear();
});
beforeAll(() => import("./latex-visual"));

/** An editor as the app mounts a .tex file's source, wired to an Overleaf document that records what it sends. */
function linkedEditor() {
  const sent: OtOp[][] = [];
  const ot = new OtDocument(DOC, 1);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        history(), closeBrackets(), keymap.of([...closeBracketsKeymap, ...baseEditorKeymap]), latex(), latexVisualSlot(HOST),
        latexEditorExtensions({ live: { current: LIVE }, currentPath: "main.tex" }), pointerSelection, EditorView.lineWrapping,
        // Each change goes to Overleaf as App sends it: the new text, diffed against what Overleaf last had.
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const { send } = ot.local(update.state.doc.toString());
          if (!send) return;
          sent.push(send.ops);
          ot.acknowledge(send.version);
        }),
      ],
    }),
  });
  views.push(view);
  return { view, sent };
}

async function visual(view: EditorView, on: boolean) {
  chooseLatexView(on ? "visual" : "source");
  await vi.waitFor(() => expect(isLatexVisual(view.state)).toBe(on));
  await Promise.resolve();
}

/** Types `text` as CodeMirror does: input handlers (bracket closing) first, else a plain insertion. */
function type(view: EditorView, text: string) {
  for (const character of text) {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({
      changes: { from, to, insert: character }, selection: { anchor: from + 1 }, annotations: Transaction.userEvent.of("input.type"),
    });
    if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, character, insert))) view.dispatch(insert());
  }
}

const press = (view: EditorView, key: string) => fireEvent.keyDown(view.contentDOM, { key });
const caret = (view: EditorView, at: number) => view.dispatch({ selection: { anchor: at }, userEvent: "select" });
/** Where `text` starts in the editor's current text. */
const find = (view: EditorView, text: string) => view.state.doc.toString().indexOf(text);

/** One writing session: click into places, type, start a list item, delete a word. Every caret is placed on visible text. */
function write(view: EditorView) {
  caret(view, find(view, "words}") + "words".length);
  type(view, " here");
  caret(view, find(view, "first point") + "first point".length);
  press(view, "Enter");
  type(view, "a new {point}");
  caret(view, find(view, "beside") + "beside".length);
  for (let count = 0; count < 3; count++) press(view, "Backspace");
  type(view, "near");
  caret(view, find(view, "We set"));
  type(view, "Here ");
}

describe("Visual mode and Overleaf sync", () => {
  it("sends nothing for switching to Visual and back, or for moving through every construct", async () => {
    const { view, sent } = linkedEditor();
    await visual(view, true);
    for (let at = 0; at <= DOC.length; at++) caret(view, at);
    for (let step = 0; step < DOC.length; step++) view.dispatch({ selection: view.moveByChar(view.state.selection.main, false) });
    await visual(view, false);
    await visual(view, true);
    expect(sent).toEqual([]);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("sends the same operations for the same typing in Visual as in Source", async () => {
    const source = linkedEditor();
    write(source.view);

    const drawn = linkedEditor();
    await visual(drawn.view, true);
    write(drawn.view);

    expect(drawn.sent).toEqual(source.sent);
    expect(drawn.view.state.doc.toString()).toBe(source.view.state.doc.toString());
    expect(source.sent.length).toBeGreaterThan(5);
  });
});
