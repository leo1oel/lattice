import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { isLatexVisual, latexVisualDataChanged } from "../latex-visual-switch";
import { chooseLatexView } from "../latex-view-choice";
import { sourceOverlays } from "../../source-overlays";
import { environmentIndex } from "./visual-environments";
import { scanConstructs } from "./visual-scan";
import { data, edits, host, text, visualView } from "./visual-test-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
// Lattice runs on macOS, and CodeMirror reads the platform once, when it loads: its keymaps here are the Mac ones.
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

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

  it("keeps typewriter text's dashes and quotes as typed", async () => {
    const view = await visualView("A \\texttt{--verbose ``x''} B", 0);
    expect(view.contentDOM.querySelector(".lx-tex-mono")?.textContent).toBe("--verbose ``x''");
  });

  it("numbers a list's items from its top when a scan starts inside a listing in it", async () => {
    const { scanContext } = await import("./latex-visual");
    const doc = "\\begin{enumerate}\n\\item one\n\\item two\n\\begin{lstlisting}\na\n\nb\n\\end{lstlisting}\n\\item three\n\\end{enumerate}\n";
    const state = EditorState.create({ doc, extensions: [environmentIndex] });
    // From inside the listing, past its blank line: the paragraph there starts within the listing.
    const context = scanContext(state, doc.indexOf("b\n\\end{lstlisting}"));
    const { constructs } = scanConstructs(doc.slice(context.start), context.start, context.frames);
    const items = constructs.flatMap((construct) => (construct.kind === "item" ? [[doc.slice(construct.to).split("\n")[0], construct.index]] : []));
    expect(items).toContainEqual(["three", 3]);
  });

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

  it("draws again from project data that changed since the last draw, on the editor's next update", async () => {
    let current = data();
    const visualHost = { ...host(), data: () => current };
    const doc = "As \\citet{vaswani2017} show.\nEnd";
    const view = await visualView(doc, doc.length, visualHost);
    const chip = () => view.contentDOM.querySelector(".lx-tex-cite")?.textContent;
    expect(chip()).not.toBe("Vaswani et al. (2017)");
    // The .bib is read after the first draw; nothing tells the editor, until it next updates.
    current = data({ citations: [{ key: "vaswani2017", title: "Attention", authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki", year: "2017", venue: "" }] });
    view.dispatch({ selection: { anchor: doc.length - 1 } });
    await Promise.resolve();
    expect(chip()).toBe("Vaswani et al. (2017)");
  });

  it("settles when the host builds fresh project data on every read", async () => {
    // Every read differs from the last, so every real update looks like a data change.
    const visualHost = { ...host(), data: () => data() };
    const redraws: number[] = [];
    const countRedraws = EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) if (tr.effects.some((effect) => effect.is(latexVisualDataChanged))) redraws.push(1);
    });
    const doc = "Some $x$ text.\nEnd";
    const view = await visualView(doc, doc.length, visualHost, countRedraws);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const afterMount = redraws.length;
    view.dispatch({ selection: { anchor: 2 } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // One caret move asks for at most one redraw, and asking is not itself a reason to ask again.
    expect(redraws.length - afterMount).toBeLessThanOrEqual(1);
    expect(afterMount).toBeLessThanOrEqual(2);
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
    chooseLatexView("source");
    await Promise.resolve();
    expect(isLatexVisual(view.state)).toBe(false);
    chooseLatexView("visual");
    await Promise.resolve();
    expect(isLatexVisual(view.state)).toBe(true);
    expect(view.state.doc).toBe(before);
    expect(edits).toEqual([]);
  });
});
