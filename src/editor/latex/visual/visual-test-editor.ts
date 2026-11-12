/** A Visual-mode .tex editor for tests, with the keys and checks they share. Each test file mocks Tauri and the platform itself. */
import { history, standardKeymap } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeAll, expect, vi } from "vitest";
import type { LatexEditorLiveData } from "../latex-editor";
import { latex } from "../latex-language";
import { isLatexVisual, latexVisualSlot, type LatexVisualHost } from "../latex-visual-switch";
import { chooseLatexView } from "../latex-view-choice";
import { pointerSelection } from "../../pointer-selection";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  localStorage.clear();
});
// The Visual module (and KaTeX with it) loads on first use; load it once up front.
beforeAll(() => import("./latex-visual"));

export const data = (overrides: Partial<LatexEditorLiveData> = {}): LatexEditorLiveData => ({
  citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [], localMacros: [],
  graphicsRoots: [], projectPaths: [], spellingWords: [], katexMacros: {}, ...overrides,
});

export function host(overrides: Partial<LatexEditorLiveData> = {}): LatexVisualHost & { opened: unknown[] } {
  const opened: unknown[] = [];
  // Built once, as in the app, where the live data's fields keep their identities between updates.
  const live = data(overrides);
  return { data: () => live, loadImage: async () => null, open: (target) => opened.push(target), opened };
}

/** Every document change an editor made, to prove that something made none. */
export const edits: unknown[] = [];
afterEach(() => edits.splice(0));
const recordEdits = EditorView.updateListener.of((update) => {
  if (update.docChanged) edits.push(update.changes.toJSON());
});

/** A .tex editor opened while the writer has chosen Visual, its window set (the microtask after mounting). */
export async function visualView(doc: string, anchor = doc.length, visualHost = host(), extensions: Extension = []) {
  chooseLatexView("visual");
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc, selection: { anchor }, extensions: [latex(), latexVisualSlot(visualHost), pointerSelection, EditorView.lineWrapping, history(), keymap.of(standardKeymap), recordEdits, extensions],
    }),
  });
  views.push(view);
  await vi.waitFor(() => expect(isLatexVisual(view.state)).toBe(true));
  await Promise.resolve();
  return view;
}

export const text = (view: EditorView) => view.contentDOM.textContent;

/** Presses `key` in the editor, through its keymaps. */
export const press = (view: EditorView, key: string, modifiers: KeyboardEventInit = {}) => runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...modifiers }), "editor");
/** Whether every `}` closes a `{` and every `{` is closed. */
export const balanced = (source: string) => {
  let depth = 0;
  for (const char of source) {
    depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
};
