import { deleteCharBackward, deleteCharForward, history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { latex } from "../latex-language";
import { isLatexVisual, latexVisualDataChanged, latexVisualSlot, setLatexVisual, type LatexVisualHost } from "../latex-visual-switch";
import type { LatexEditorLiveData } from "../latex-editor";
import { pointerSelection } from "../../pointer-selection";
import { sourceOverlays } from "../../source-overlays";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));
// The Visual module (and KaTeX with it) loads on first use; load it once up front.
beforeAll(() => import("./latex-visual"));

const data = (overrides: Partial<LatexEditorLiveData> = {}): LatexEditorLiveData => ({
  citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [], localMacros: [],
  graphicsRoots: [], projectPaths: [], spellingWords: [], katexMacros: {}, ...overrides,
});

function host(overrides: Partial<LatexEditorLiveData> = {}): LatexVisualHost & { opened: unknown[] } {
  const opened: unknown[] = [];
  return { data: () => data(overrides), loadImage: async () => null, open: (target) => opened.push(target), opened };
}

/** Every document change an editor made, to prove that something made none. */
const edits: unknown[] = [];
afterEach(() => edits.splice(0));
const recordEdits = EditorView.updateListener.of((update) => {
  if (update.docChanged) edits.push(update.changes.toJSON());
});

/** A .tex editor in Visual mode, its window set (the microtask after mounting). */
async function visualView(doc: string, anchor = doc.length, visualHost = host(), extensions: Extension = []) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc, selection: { anchor }, extensions: [latex(), latexVisualSlot, pointerSelection, EditorView.lineWrapping, history(), recordEdits, extensions],
    }),
  });
  views.push(view);
  setLatexVisual(view, true, visualHost, () => true);
  await vi.waitFor(() => expect(isLatexVisual(view.state)).toBe(true));
  await Promise.resolve();
  return view;
}

const text = (view: EditorView) => view.contentDOM.textContent;

describe("LaTeX Visual mode", () => {
  it("draws emphasis, headings and math, hiding their commands", async () => {
    const view = await visualView("\\section{Intro}\nSome \\textbf{bold} and $x^2$ here.\n\nEnd.");
    expect(isLatexVisual(view.state)).toBe(true);
    expect(view.dom.classList.contains("cm-latex-visual")).toBe(true);
    expect(text(view)).not.toContain("\\textbf");
    expect(text(view)).not.toContain("\\section");
    expect(view.contentDOM.querySelector(".lx-tex-bold")?.textContent).toBe("bold");
    expect(view.contentDOM.querySelector(".cm-line.lx-tex-heading-2")?.textContent).toBe("Intro");
    expect(view.contentDOM.querySelector(".lx-tex-math .katex")).not.toBeNull();
  });

  it("shows a construct's source while the caret touches it, and draws it again once the caret leaves", async () => {
    const doc = "Before $a+b$ after.";
    const view = await visualView(doc, 0);
    expect(view.contentDOM.querySelector(".lx-tex-math")).not.toBeNull();
    view.dispatch({ selection: { anchor: doc.indexOf("a+b") } });
    expect(view.contentDOM.querySelector(".lx-tex-math")).toBeNull();
    expect(text(view)).toContain("$a+b$");
    // Just past the closing `$` still touches it.
    view.dispatch({ selection: { anchor: doc.indexOf("$ after") + 1 } });
    expect(view.contentDOM.querySelector(".lx-tex-math")).toBeNull();
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.contentDOM.querySelector(".lx-tex-math")).not.toBeNull();
  });

  it("keeps a styled argument's command hidden while editing it, showing faint braces", async () => {
    const doc = "A \\emph{word} here";
    const view = await visualView(doc, doc.indexOf("word") + 2);
    expect(text(view)).not.toContain("\\emph");
    expect([...view.contentDOM.querySelectorAll(".lx-tex-brace")].map((brace) => brace.textContent)).toEqual(["{", "}"]);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.contentDOM.querySelectorAll(".lx-tex-brace")).toHaveLength(0);
  });

  // Each family of hidden opening token: a style command, a footnote, a link, an old-style switch.
  const wrapped = [
    { doc: "A \\textbf{word} B", opening: "\\textbf{", content: "word", unwrapped: "A word B" },
    { doc: "See\\footnote{a note} end", opening: "\\footnote{", content: "a note", unwrapped: "Seea note end" },
    { doc: "Go to \\href{https://x.org}{the site} now", opening: "\\href{https://x.org}{", content: "the site", unwrapped: "Go to the site now" },
    { doc: "An {\\bf old} switch", opening: "{\\bf ", content: "old", unwrapped: "An old switch" },
  ];
  for (const { doc, opening, content, unwrapped } of wrapped) {
    const cases = [
      { name: "Backspace at the content's start", anchor: doc.indexOf(content), command: deleteCharBackward },
      { name: "Delete at the opening token's start", anchor: doc.indexOf(content) - opening.length, command: deleteCharForward },
    ];
    for (const { name, anchor, command } of cases) {
      it(`unwraps ${JSON.stringify(doc)} on ${name}, leaving no lone brace, and one undo restores it`, async () => {
        const view = await visualView(doc, anchor);
        expect(command(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(unwrapped);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc);
      });
    }
  }

  it("opens an indented figure image's source on a click", async () => {
    const doc = "\\begin{figure}\n  \\includegraphics{a.png}\n\\end{figure}\nText.";
    const view = await visualView(doc);
    const image = view.contentDOM.querySelector<HTMLElement>(".lx-tex-image.is-block")!;
    image.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("\\includegraphics"));
    expect(view.contentDOM.querySelector(".lx-tex-image")).toBeNull();
    expect(text(view)).toContain("\\includegraphics{a.png}");
  });

  it("opens the preamble and the end of the document under an overlay such as a co-author's change", async () => {
    const doc = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHello.\n\\end{document}";
    const marked = [doc.indexOf("amsmath"), doc.lastIndexOf("document")];
    const overlay = sourceOverlays.of(() => Decoration.set(marked.map((from) => Decoration.mark({}).range(from, from + 3))));
    const view = await visualView(doc, doc.indexOf("Hello"), host(), overlay);
    expect(text(view)).toContain("\\usepackage{amsmath}");
    expect(text(view)).toContain("\\end{document}");
    expect(view.contentDOM.querySelector(".lx-tex-end-document")).toBeNull();
  });

  it("steps over a hidden command in one arrow press", async () => {
    const doc = "x \\textbf{y} z";
    const view = await visualView(doc, 2);
    // From before the hidden `\textbf{`, one step right lands inside the argument.
    const moved = view.moveByChar(view.state.selection.main, true);
    expect(moved.head).toBe(doc.indexOf("y"));
  });

  it("holds what it draws while the pointer is down, and settles on release", async () => {
    const doc = "Before $a+b$ after.";
    const view = await visualView(doc, 0);
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    view.dispatch({ selection: { anchor: doc.indexOf("a+b") } });
    expect(view.contentDOM.querySelector(".lx-tex-math")).not.toBeNull();
    view.dom.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    expect(view.contentDOM.querySelector(".lx-tex-math")).toBeNull();
  });

  it("draws list markers by kind and depth, and keeps the caret off the marker", async () => {
    const doc = "\\begin{enumerate}\n\\item one\n\\item two\n\\end{enumerate}\n\\begin{itemize}\n  \\item dot\n\\end{itemize}\n";
    const view = await visualView(doc, doc.indexOf("one"));
    expect([...view.contentDOM.querySelectorAll(".lx-tex-marker")].map((marker) => marker.textContent)).toEqual(["1.", "2.", "•"]);
    expect(text(view)).not.toContain("\\item");
    expect(text(view)).not.toContain("\\begin{enumerate}");
    // Arriving at a marker's start (Home) moves past the marker.
    view.dispatch({ selection: { anchor: doc.indexOf("\\item two") } });
    expect(view.state.selection.main.head).toBe(doc.indexOf("two"));
    // Stepping left from just past a marker goes to the end of the line above.
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("\\item two")) });
    expect(view.state.selection.main.head).toBe(doc.indexOf("\n\\item two"));
  });

  it("numbers references and equations from the last build, with ? before one", async () => {
    const doc = "See \\eqref{eq:a}.\n\\begin{equation}\\label{eq:a}\nx = 1\n\\end{equation}\nDone.";
    const view = await visualView(doc, doc.length);
    expect(view.contentDOM.querySelector(".lx-tex-ref")?.textContent).toBe("(?)");
    expect(view.contentDOM.querySelector(".lx-tex-math-display")?.textContent).toContain("(?)");
  });

  it("shows citations as chips with author and year, and \\input as a link that opens the file", async () => {
    const visualHost = host({
      citations: [{ key: "vaswani2017", title: "Attention", authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki", year: "2017", venue: "" }],
      projectPaths: ["chapters/intro.tex"],
    });
    const view = await visualView("As \\citet{vaswani2017} show.\n\\input{chapters/intro}\nEnd", 0, visualHost);
    expect(view.contentDOM.querySelector(".lx-tex-cite")?.textContent).toBe("Vaswani et al. (2017)");
    const link = view.contentDOM.querySelector<HTMLElement>(".lx-tex-include")!;
    expect(link.textContent).toBe("chapters/intro");
    link.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
    expect(visualHost.opened).toEqual([{ kind: "include", path: "chapters/intro.tex" }]);
  });

  it("folds the preamble, opening it when the caret is in it", async () => {
    const doc = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHello.\n\\end{document}\n";
    const view = await visualView(doc, 0);
    // A caret left at the very start moves to the body.
    await Promise.resolve();
    expect(view.state.selection.main.head).toBe(doc.indexOf("Hello"));
    expect(text(view)).not.toContain("\\usepackage");
    expect(view.contentDOM.querySelector(".lx-tex-preamble")?.textContent).toBe("Show preamble");
    view.dispatch({ selection: { anchor: 3 } });
    expect(text(view)).toContain("\\usepackage{amsmath}");
  });

  it("draws \\maketitle as the title block its \\title and \\author describe", async () => {
    const doc = "\\documentclass{article}\n\\title{On \\emph{Attention}}\n\\author{Ada \\\\ \\texttt{a@x.org} \\and Grace\\thanks{Navy}}\n\\begin{document}\n\\maketitle\nText.\n\\end{document}\n";
    const view = await visualView(doc, doc.indexOf("Text"));
    expect(view.contentDOM.querySelector(".lx-tex-title")?.textContent).toBe("On Attention");
    expect([...view.contentDOM.querySelectorAll(".lx-tex-author")].map((author) => author.textContent)).toEqual(["Adaa@x.org", "Grace"]);
  });

  it("leaves unknown commands, line breaks and comments as source", async () => {
    const doc = "\\foo[bar]{baz} a \\\\ b % \\textbf{no}\n";
    const view = await visualView(doc, 0);
    expect(text(view)).toBe(doc.trimEnd());
  });

  it("never changes the text: switching modes and moving the caret are no edits", async () => {
    const doc = "\\documentclass{article}\n\\begin{document}\n\\section{A}\n\\textbf{b} $c$ \\cite{d}\n\\begin{itemize}\n\\item e\n\\end{itemize}\n\\end{document}\n";
    const view = await visualView(doc, doc.indexOf("\\section"));
    const before = view.state.doc;
    for (let position = 0; position <= doc.length; position++) view.dispatch({ selection: { anchor: position } });
    for (let position = 0; position <= doc.length; position++) view.dispatch({ selection: view.moveByChar(view.state.selection.main, true) });
    view.dispatch({ effects: latexVisualDataChanged.of(null) });
    setLatexVisual(view, false, host(), () => true);
    expect(isLatexVisual(view.state)).toBe(false);
    setLatexVisual(view, true, host(), () => true);
    await Promise.resolve();
    expect(isLatexVisual(view.state)).toBe(true);
    expect(view.state.doc).toBe(before);
    expect(edits).toEqual([]);
  });
});
