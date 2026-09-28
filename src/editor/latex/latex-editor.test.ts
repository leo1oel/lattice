import {
  closeBrackets, closeBracketsKeymap, completionStatus, currentCompletions, insertBracket, selectedCompletionIndex,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import { openSearchPanel, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  insertLatexNewline, latexEditorExtensions, selectionVisibilityExtension,
  type LatexEditorLiveData, type LatexEditorOptions,
} from "./latex-editor";
import { citationTooltipSpace } from "./latex-hover-cards";
import { compactSearchPanel } from "./search-panel";

const EMPTY_LIVE: LatexEditorLiveData = {
  citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [], localMacros: [],
  graphicsRoots: [], projectPaths: [], spellingWords: [],
};

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.restoreAllMocks();
});

function mount(state: EditorState): EditorView {
  const view = new EditorView({ parent: document.body, state });
  views.push(view);
  return view;
}

function latexView(
  doc = "",
  anchor = doc.length,
  live: Partial<LatexEditorLiveData> = {},
  options: Partial<LatexEditorOptions> = {},
  before: Extension[] = [],
): EditorView {
  return mount(EditorState.create({
    doc,
    selection: { anchor },
    extensions: [...before, latexEditorExtensions({ live: { current: { ...EMPTY_LIVE, ...live } }, ...options })],
  }));
}

/** The editor as the app mounts it, including the bracket keymap that runs before ours. */
const productionLatexView = (citationKeys: string[]) =>
  latexView("", 0, { citationKeys }, {}, [closeBrackets(), keymap.of([...closeBracketsKeymap, ...defaultKeymap])]);

function typeText(view: EditorView, text: string): void {
  for (const character of text) {
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: character },
      selection: { anchor: range.from + character.length },
      annotations: Transaction.userEvent.of("input.type"),
    });
  }
}

function typeBracket(view: EditorView, bracket: "{" | "}"): void {
  const code = bracket === "{" ? "BracketLeft" : "BracketRight";
  const event = new KeyboardEvent("keydown", { key: bracket, code, shiftKey: true, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  if (event.defaultPrevented) return;
  const transaction = insertBracket(view.state, bracket);
  if (transaction) view.dispatch(transaction);
  else typeText(view, bracket);
}

const press = (view: EditorView, ...keys: string[]) => {
  for (const key of keys) fireEvent.keyDown(view.contentDOM, { key, code: key });
};
const labels = (view: EditorView) => currentCompletions(view.state).map((item) => item.label);
const doc = (view: EditorView) => view.state.doc.toString();

describe("LaTeX editor extensions", () => {
  it("shows the current and total matches in the find panel", () => {
    const view = mount(EditorState.create({ doc: "alpha alpha alpha", extensions: [search({ top: true }), compactSearchPanel()] }));
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha" })), selection: { anchor: 6, head: 11 } });
    expect(view.dom.querySelector(".cm-search-count")).toHaveTextContent("2/3");
  });

  it("soft-wraps lines and keeps native spellcheck off whether or not Harper is enabled", () => {
    for (const spellcheck of [false, true]) {
      const view = latexView("A single logical line that can wrap across several visual rows.", 0, {}, { spellcheck });
      expect(view.contentDOM).toHaveClass("cm-lineWrapping");
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
      expect(view.contentDOM.getAttribute("autocorrect")).toBe("off");
    }
  });

  it("marks the editor when a text range is selected so active-line fill can clear", () => {
    const view = mount(EditorState.create({ doc: "hello world", extensions: selectionVisibilityExtension() }));
    const marked = () => view.dom.classList.contains("cm-lattice-has-selection");
    expect(marked()).toBe(false);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(marked()).toBe(true);
    view.dispatch({ selection: { anchor: 5, head: 5 } });
    expect(marked()).toBe(false);
  });

  it("bounds citation tooltips to the editor", () => {
    expect(citationTooltipSpace({ left: 320, right: 720, top: 80, bottom: 680 }))
      .toEqual({ left: 328, right: 712, top: 88, bottom: 672 });
  });

  it.each([
    ["waits for a typed citation's opening brace", "\\cit", ["vaswani2017attention"], 4, 4, "e", "input.type", "\\cite"],
    ["keeps an existing brace pair while typing", "\\cit{}", [], 4, 4, "e", "input.type", "\\cite{}"],
    ["adds braces when a citation command is accepted from completion", "\\ci", [], 0, 3, "\\cite", "input.complete", "\\cite{}"],
  ])("%s", (_name, source, citationKeys, from, to, insert, userEvent, expected) => {
    const view = latexView(source, to, { citationKeys });
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      annotations: Transaction.userEvent.of(userEvent),
    });
    expect(doc(view)).toBe(expected);
  });

  it("shows citation keys immediately for an empty slot and after a comma", async () => {
    const view = latexView("\\cit", 4, { citationKeys: ["vaswani2017attention", "dosovitskiy2021image"] });
    typeText(view, "e");
    typeBracket(view, "{");
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(labels(view)).toEqual(["dosovitskiy2021image", "vaswani2017attention"]);
    typeText(view, "first,");
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(labels(view)).toContain("vaswani2017attention");
  });

  it("finds citation keys by a multiword title while typing", async () => {
    const view = latexView("\\citep{Spatial}", 14, {
      citations: [
        { key: "lee2026", title: "Exploring Spatial Workspace", authors: "Lee", year: "2026", venue: "" },
        { key: "other2025", title: "Other work", authors: "Other", year: "2025", venue: "" },
      ],
    });
    startCompletion(view);
    await vi.waitFor(() => expect(labels(view)).toEqual(["lee2026"]));
    typeText(view, " Workspace");
    await vi.waitFor(() => expect(labels(view)).toEqual(["lee2026"]));
    typeText(view, " nonexistent");
    await vi.waitFor(() => expect(labels(view)).toEqual([]));
  });

  it.each(["A Study of Collaborative Writing", ""])("renders citation metadata with title %j but inserts only its key", async (title) => {
    const source = "\\cite{existing,work}";
    const view = latexView(source, source.length - 1, {
      citations: [{ key: "work2026", title, authors: "Alice Lee", year: "2026", venue: "CHI" }],
    });
    startCompletion(view);
    await vi.waitFor(() => {
      const option = view.dom.querySelector(".cm-citation-option");
      expect(option?.querySelector(".cm-completionLabel")?.textContent).toBe(title || "work2026");
      expect(option?.querySelector(".cm-completionDetail")?.textContent).toBe(
        title ? "work2026 · Alice Lee · 2026 · CHI" : "Alice Lee · 2026 · CHI",
      );
    });
    press(view, "Enter");
    expect(doc(view)).toBe("\\cite{existing,work2026}");
  });

  it.each([0, 3, 9])("replaces the whole citation key from cursor offset %i without touching adjacent entries", async (offset) => {
    const source = "\\citep{left2023,  alpha2024  ,right2025}";
    const start = source.indexOf("alpha2024");
    const view = latexView(source, start + offset, { citationKeys: ["alpha2024", "alpha2024extended"] });
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    press(view, "Enter");
    expect(doc(view)).toBe(source);
    view.dispatch({ selection: { anchor: start + offset } });
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    press(view, "ArrowDown", "Enter");
    expect(doc(view)).toBe("\\citep{left2023,  alpha2024extended  ,right2025}");
  });

  it("lets an immediately pressed arrow and Enter choose a citation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const view = latexView("\\cite{}", 6, { citationKeys: ["vaswani2017attention", "dosovitskiy2021image"] });
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(selectedCompletionIndex(view.state)).toBe(0);
    press(view, "ArrowDown");
    expect(selectedCompletionIndex(view.state)).toBe(1);
    press(view, "Enter");
    expect(doc(view)).toBe("\\cite{vaswani2017attention}");
  });

  // A literally typed command with the production bracket keymap: the brace
  // pair lands around the cursor and the choices open without the suffix lost.
  it.each(["cite", "citep", "citet", "citeauthor", "parencite"])("opens citations after typing \\%s{ without swallowing the command suffix", async (command) => {
    const view = productionLatexView(["alpha2024", "beta2025"]);
    typeText(view, `\\${command}`);
    expect(doc(view)).toBe(`\\${command}`);
    typeBracket(view, "{");
    expect(doc(view)).toBe(`\\${command}{}`);
    expect(view.state.selection.main.head).toBe(command.length + 2);
    await vi.waitFor(() => expect(labels(view)).toEqual(["alpha2024", "beta2025"]));
    press(view, "ArrowDown");
    expect(selectedCompletionIndex(view.state)).toBe(1);
    press(view, "Enter");
    expect(doc(view)).toBe(`\\${command}{beta2025}`);
  });

  it("reopens citation choices when the cursor returns, but respects Escape and selections", async () => {
    const view = productionLatexView(["alpha2024", "beta2025"]);
    const source = "Text \\citep{} and \\section{}";
    view.dispatch({ changes: { from: 0, insert: source } });
    view.focus();
    const slot = source.indexOf("{}");
    view.dispatch({ selection: { anchor: slot + 1 } });
    await vi.waitFor(() => expect(labels(view)).toEqual(["alpha2024", "beta2025"]));
    press(view, "Escape");
    expect(completionStatus(view.state)).toBeNull();
    for (const selection of [undefined, { anchor: source.length - 1 }, { anchor: slot, head: slot + 2 }]) {
      view.dispatch({ selection });
      expect(completionStatus(view.state)).toBeNull();
    }
    view.dispatch({ selection: { anchor: slot + 1 } });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  });

  it("reopens an unchanged citation cursor after focus returns from another control", async () => {
    const view = productionLatexView(["alpha2024"]);
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    view.dispatch({ changes: { from: 0, insert: "\\citep{}" }, selection: { anchor: 7 } });
    expect(completionStatus(view.state)).toBeNull();
    view.focus();
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    input.focus();
    await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull());
    view.focus();
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    input.remove();
  });

  it("does not accumulate closing braces while deleting a literally typed citation", () => {
    const view = productionLatexView(["vaswani2017attention"]);
    typeText(view, "\\cite");
    typeBracket(view, "{");
    typeBracket(view, "}");
    expect(doc(view)).toBe("\\cite{}");
    expect(view.state.selection.main.head).toBe(7);
    for (const expected of ["\\cite{", "\\cite", "\\cit"]) {
      press(view, "Backspace");
      expect(doc(view)).toBe(expected);
    }
  });

  it.each([
    ["starts the next line at the current indent, not an extra tab inside a document",
      "\\begin{document}\nHello\n\\end{document}", "Hello", "\\begin{document}\nHello\n\n\\end{document}"],
    ["keeps an already-indented line's indent on newline",
      "\\begin{itemize}\n  \\item one\n\\end{itemize}", "one", "\\begin{itemize}\n  \\item one\n  \n\\end{itemize}"],
    ["closes an environment when Enter follows its \\begin, with the caret on the body line",
      "\\begin{align}", "\\begin{align}", "\\begin{align}\n  |\n\\end{align}"],
    ["keeps the \\begin line's indent for the body and the \\end",
      "  \\begin{itemize}  ", "\\begin{itemize}  ", "  \\begin{itemize}\n    |\n  \\end{itemize}"],
    ["only indents the body when the environment is already closed",
      "\\begin{itemize}\n\\end{itemize}", "\\begin{itemize}", "\\begin{itemize}\n  |\n\\end{itemize}"],
    ["does not duplicate the \\end of an environment that already has items",
      "\\begin{itemize}\n  \\item a\n\\end{itemize}", "\\begin{itemize}", "\\begin{itemize}\n  |\n  \\item a\n\\end{itemize}"],
    ["closes a nested environment of the same name inside a closed one",
      "\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n\\end{itemize}", "  \\begin{itemize}",
      "\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    |\n  \\end{itemize}\n\\end{itemize}"],
  ])("%s", (_name, source, cursorAfter, expected) => {
    const view = latexView(source, source.indexOf(cursorAfter) + cursorAfter.length);
    expect(insertLatexNewline(view)).toBe(true);
    const { head } = view.state.selection.main;
    expect(expected.includes("|") ? `${doc(view).slice(0, head)}|${doc(view).slice(head)}` : doc(view)).toBe(expected);
  });
});
