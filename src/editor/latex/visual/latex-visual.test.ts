import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { deleteGroupBackward, history, standardKeymap, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { latex } from "../latex-language";
import { isLatexVisual, latexVisualDataChanged, latexVisualSlot, type LatexVisualHost } from "../latex-visual-switch";
import { chooseLatexView } from "../latex-view-choice";
import type { LatexEditorLiveData } from "../latex-editor";
import { pointerSelection } from "../../pointer-selection";
import { sourceOverlays } from "../../source-overlays";
import { environmentIndex } from "./visual-environments";
import { scanConstructs } from "./visual-scan";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
// Lattice runs on macOS, and CodeMirror reads the platform once, when it loads: its keymaps here are the Mac ones.
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  localStorage.clear();
});
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

/** A .tex editor opened while the writer has chosen Visual, its window set (the microtask after mounting). */
async function visualView(doc: string, anchor = doc.length, visualHost = host(), extensions: Extension = []) {
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

  /** Presses `key` in the editor, through its keymaps. */
  const press = (view: EditorView, key: string, modifiers: KeyboardEventInit = {}) => runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...modifiers }), "editor");
  /** Whether every `}` closes a `{` and every `{` is closed. */
  const balanced = (source: string) => {
    let depth = 0;
    for (const char of source) {
      depth += char === "{" ? 1 : char === "}" ? -1 : 0;
      if (depth < 0) return false;
    }
    return depth === 0;
  };

  // Each family of styled text whose tokens Visual mode hides: a style command, a footnote, a URL, a link, an old-style switch.
  const families = [
    { open: "\\textbf{", content: "word" },
    { open: "\\footnote{", content: "note" },
    { open: "\\url{", content: "x.org" },
    { open: "\\href{https://x.org}{", content: "site" },
    { open: "{\\bf ", content: "old" },
  ];
  for (const { open, content } of families) {
    const doc = `A ${open}${content}} B`;
    const start = 2 + open.length;
    const end = start + content.length;
    // Backspace and Delete step over a hidden token to the nearest visible character; selections unwrap or delete whole.
    // `typed`: the text after then typing "s", which shows the caret stayed on its side of the hidden tokens.
    const cases = [
      { name: "Backspace just after the hidden }", anchor: end + 1, head: end + 1, key: "Backspace", expected: `A ${open}${content.slice(0, -1)}} B`, typed: `A ${open}${content.slice(0, -1)}}s B` },
      { name: "Backspace at the content's start", anchor: start, head: start, key: "Backspace", expected: `A${open}${content}} B`, typed: `A${open}s${content}} B` },
      { name: "Delete at the content's end", anchor: end, head: end, key: "Delete", expected: `A ${open}${content}}B`, typed: `A ${open}${content}s}B` },
      { name: "Delete before the hidden opening", anchor: 2, head: 2, key: "Delete", expected: `A ${open}${content.slice(1)}} B`, typed: `A s${open}${content.slice(1)}} B` },
      { name: "deleting a selection over all of it", anchor: 2, head: end + 1, key: "Backspace", expected: "A  B", typed: null },
      { name: "deleting a selection over its opening", anchor: 2, head: start + 1, key: "Backspace", expected: `A ${content.slice(1)} B`, typed: null },
      { name: "deleting a selection over its closing", anchor: end - 1, head: end + 1, key: "Delete", expected: `A ${content.slice(0, -1)} B`, typed: null },
    ];
    for (const { name, anchor, head, key, expected, typed } of cases) {
      it(`${JSON.stringify(doc)}: ${name} leaves ${JSON.stringify(expected)}, and one undo restores it`, async () => {
        const view = await visualView(doc, anchor);
        view.dispatch({ selection: { anchor, head } });
        expect(press(view, key)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        expect(balanced(view.state.doc.toString())).toBe(true);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc);
        if (typed === null) return;
        view.dispatch({ selection: { anchor, head } });
        press(view, key);
        view.dispatch(view.state.replaceSelection("s"));
        expect(view.state.doc.toString()).toBe(typed);
      });
    }

    it(`${JSON.stringify(doc)}: deleted letter by letter from outside, it empties, and the next key removes it whole`, async () => {
      const fromAfter = await visualView(`A ${open}ab} B`, start + 3);
      expect(press(fromAfter, "Backspace")).toBe(true);
      expect(fromAfter.state.doc.toString()).toBe(`A ${open}a} B`);
      expect(press(fromAfter, "Backspace")).toBe(true);
      expect(fromAfter.state.doc.toString()).toBe(`A ${open}} B`);
      expect(press(fromAfter, "Backspace")).toBe(true);
      expect(fromAfter.state.doc.toString()).toBe("A  B");

      const fromBefore = await visualView(`A ${open}ab} B`, 2);
      expect(press(fromBefore, "Delete")).toBe(true);
      expect(fromBefore.state.doc.toString()).toBe(`A ${open}b} B`);
      expect(press(fromBefore, "Delete")).toBe(true);
      expect(fromBefore.state.doc.toString()).toBe(`A ${open}} B`);
      expect(press(fromBefore, "Delete")).toBe(true);
      expect(fromBefore.state.doc.toString()).toBe("A  B");
    });
  }

  it("deletes only the bracket pair of a just-typed empty argument, as Source does, keeping a link's URL", async () => {
    const brackets = [closeBrackets(), Prec.high(keymap.of(closeBracketsKeymap))];
    for (const typed of ["A \\href{https://x.org}{} B", "A \\textbf{} B"]) {
      const view = await visualView(typed, typed.indexOf("{}") + 1, host(), brackets);
      expect(press(view, "Backspace")).toBe(true);
      expect(view.state.doc.toString()).toBe(typed.replace("{}", ""));
    }
  });

  it("steps over hidden tokens on the Mac's Ctrl-h and Ctrl-d as on Backspace and Delete", async () => {
    const doc = "A \\textbf{word} B";
    const view = await visualView(doc, doc.indexOf("} B") + 1);
    expect(press(view, "h", { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("A \\textbf{wor} B");
    view.dispatch({ selection: { anchor: 2 } });
    expect(press(view, "d", { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("A \\textbf{or} B");
  });

  it("steps over a heading's hidden closing brace too, deleting the visible character before it", async () => {
    const doc = "\\paragraph{Setup.}\\emph{Note} text";
    const view = await visualView(doc, doc.indexOf("Note"));
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("\\paragraph{Setup}\\emph{Note} text");
  });

  it("steps over a revealed heading's or caption's tokens, never deleting one alone", async () => {
    for (const command of ["\\section", "\\caption"]) {
      const doc = `Text\n${command}{Intro}\nMore`;
      const view = await visualView(doc, doc.indexOf("}") + 1);
      expect(press(view, "Backspace")).toBe(true);
      expect(view.state.doc.toString()).toBe(`Text\n${command}{Intr}\nMore`);
      expect(view.state.selection.main.head).toBe(doc.indexOf("}"));

      const atStart = await visualView(doc, doc.indexOf("Intro"));
      expect(press(atStart, "Backspace")).toBe(true);
      expect(atStart.state.doc.toString()).toBe(`Text${command}{Intro}\nMore`);
      expect(balanced(atStart.state.doc.toString())).toBe(true);
    }
  });

  it("keeps a heading's closing brace when its command is retyped over, and unwraps it when the command is only deleted", async () => {
    const replacements = [
      { doc: "Text\n\\section{Intro}\nMore", token: "\\section{", insert: "\\subsection{", expected: "Text\n\\subsection{Intro}\nMore" },
      { doc: "Text\n\\caption{A cat}\nMore", token: "\\caption{", insert: "\\caption[Cat]{", expected: "Text\n\\caption[Cat]{A cat}\nMore" },
    ];
    for (const { doc, token, insert, expected } of replacements) {
      const from = doc.indexOf(token);
      const view = await visualView(doc, from);
      view.dispatch({ changes: { from, to: from + token.length, insert }, userEvent: "input.paste" });
      expect(view.state.doc.toString()).toBe(expected);

      const deleted = await visualView(doc, from);
      deleted.dispatch({ selection: { anchor: from, head: from + token.length } });
      expect(press(deleted, "Backspace")).toBe(true);
      expect(deleted.state.doc.toString()).toBe(doc.replace(token, "").replace("}", ""));
    }
  });

  it("removes a description item's marker on leaving its term over a bracket, keeping the term on its line", async () => {
    const doc = "\\begin{description}\n\\item[A] first\n  \\item[Term] text\n\\end{description}";
    const unwrapped = "\\begin{description}\n\\item[A] first\nTerm text\n\\end{description}";
    const atStart = await visualView(doc, doc.indexOf("Term"));
    expect(press(atStart, "Backspace")).toBe(true);
    expect(atStart.state.doc.toString()).toBe(unwrapped);
    expect(atStart.state.selection.main.head).toBe(unwrapped.indexOf("Term"));
    expect(undo(atStart)).toBe(true);
    expect(atStart.state.doc.toString()).toBe(doc);

    const atEnd = await visualView(doc, doc.indexOf("] text"));
    expect(press(atEnd, "Delete")).toBe(true);
    expect(atEnd.state.doc.toString()).toBe(unwrapped);
    expect(atEnd.state.selection.main.head).toBe(unwrapped.indexOf(" text"));

    // The first item's line keeps `\begin{description}` alone on the line above.
    const first = await visualView(doc, doc.indexOf("A]"));
    expect(press(first, "Backspace")).toBe(true);
    expect(first.state.doc.toString()).toBe(doc.replace("\\item[A]", "A"));

    const selected = await visualView(doc, doc.length);
    // From the term's last letter through the `] ` drawn as the gap after it.
    selected.dispatch({ selection: { anchor: doc.indexOf("m]"), head: doc.indexOf("text") } });
    expect(press(selected, "Backspace")).toBe(true);
    expect(selected.state.doc.toString()).toBe("\\begin{description}\n\\item[A] first\n  Tertext\n\\end{description}");
    expect(undo(selected)).toBe(true);
    expect(selected.state.doc.toString()).toBe(doc);
  });

  it("never deletes the line break under the folded preamble or the end-of-document bar", async () => {
    const doc = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nHello.\n\\end{document}\n";
    const atBody = await visualView(doc, doc.indexOf("\\section"));
    expect(press(atBody, "Backspace")).toBe(true);
    expect(atBody.state.doc.toString()).toBe(doc);
    expect(atBody.contentDOM.querySelector(".lx-tex-preamble")?.textContent).toBe("Show preamble");

    const atTitle = await visualView(doc, doc.indexOf("Intro"));
    expect(press(atTitle, "Backspace")).toBe(true);
    expect(atTitle.state.doc.toString()).toBe(doc);

    const atEnd = await visualView(doc, doc.indexOf("\n\\end{document}"));
    expect(press(atEnd, "Delete")).toBe(true);
    expect(atEnd.state.doc.toString()).toBe(doc);
    expect(atEnd.contentDOM.querySelector(".lx-tex-end-document")).not.toBeNull();
  });

  it("still removes a blank line next to a drawn list end or figure, without joining text onto them", async () => {
    const doc = "\\begin{itemize}\n\\item one\n\\end{itemize}\n\nText\n\n\\begin{figure}\n\\caption{A}\n\\end{figure}\nEnd";
    const afterList = await visualView(doc, doc.indexOf("\n\nText") + 1);
    expect(press(afterList, "Backspace")).toBe(true);
    expect(afterList.state.doc.toString()).toBe(doc.replace("\\end{itemize}\n\n", "\\end{itemize}\n"));

    const beforeFigure = await visualView(doc, doc.indexOf("\n\\begin{figure}"));
    expect(press(beforeFigure, "Delete")).toBe(true);
    expect(beforeFigure.state.doc.toString()).toBe(doc.replace("Text\n\n", "Text\n"));

    const ontoFigure = await visualView(doc, doc.indexOf("End"));
    expect(press(ontoFigure, "Backspace")).toBe(true);
    expect(ontoFigure.state.doc.toString()).toBe(doc);
  });

  it("never deletes a blank line's break under the folded preamble or above the end-of-document bar", async () => {
    const doc = "\\documentclass{article}\n\\begin{document}\n\nHello.\n\n\\end{document}\n";
    const afterPreamble = await visualView(doc, doc.indexOf("\n\nHello") + 1);
    expect(press(afterPreamble, "Backspace")).toBe(true);
    expect(afterPreamble.state.doc.toString()).toBe(doc);

    const beforeEnd = await visualView(doc, doc.indexOf("\n\\end{document}"));
    expect(press(beforeEnd, "Delete")).toBe(true);
    expect(beforeEnd.state.doc.toString()).toBe(doc);
  });

  it("deletes words and line parts as drawn: a styled word goes whole, the rest of a construct keeps its tokens", async () => {
    const doc = "A \\textbf{bold} B";
    const afterWord = await visualView(doc, doc.indexOf(" B"));
    expect(press(afterWord, "Backspace", { altKey: true })).toBe(true);
    expect(afterWord.state.doc.toString()).toBe("A  B");
    expect(undo(afterWord)).toBe(true);
    expect(afterWord.state.doc.toString()).toBe(doc);

    const beforeWord = await visualView(doc, doc.indexOf("\\textbf"));
    expect(press(beforeWord, "Delete", { altKey: true })).toBe(true);
    expect(beforeWord.state.doc.toString()).toBe("A  B");
    expect(beforeWord.state.selection.main.head).toBe(2);

    const inside = "\\textbf{bold} rest";
    const toLineStart = await visualView(inside, inside.indexOf("ld"));
    expect(press(toLineStart, "Backspace", { metaKey: true })).toBe(true);
    expect(toLineStart.state.doc.toString()).toBe("\\textbf{ld} rest");
    expect(toLineStart.contentDOM.querySelector(".lx-tex-bold")?.textContent).toBe("ld");

    const heading = "Text\n\\section{Introduction}\nWe study";
    const inTitle = await visualView(heading, heading.indexOf("duction"));
    expect(press(inTitle, "Backspace", { metaKey: true })).toBe(true);
    expect(inTitle.state.doc.toString()).toBe("Text\n\\section{duction}\nWe study");
    expect(balanced(inTitle.state.doc.toString())).toBe(true);
  });

  it("deletes a formula that runs over a line break whole, by word", async () => {
    const doc = "see $a +\nb$ here";
    const after = await visualView(doc, doc.indexOf("here"));
    expect(press(after, "Backspace", { altKey: true })).toBe(true);
    expect(after.state.doc.toString()).toBe("see here");

    const before = await visualView(doc, doc.indexOf(" $"));
    expect(press(before, "Delete", { altKey: true })).toBe(true);
    expect(before.state.doc.toString()).toBe("see here");
  });

  it("deletes words inside a revealed heading's command as the text they show, keeping its braces", async () => {
    const doc = "Text\n\\subsection{Intro}\nMore";
    // What Source deletes there: CodeMirror's own word deletion, over the same LaTeX.
    const source = { state: EditorState.create({ doc, selection: { anchor: doc.indexOf("section") }, extensions: latex() }) };
    deleteGroupBackward({ state: source.state, dispatch: (transaction) => (source.state = transaction.state) });
    const back = await visualView(doc, doc.indexOf("section"));
    expect(press(back, "Backspace", { altKey: true })).toBe(true);
    expect(back.state.doc.toString()).toBe(source.state.doc.toString());
    expect(back.state.doc.toString()).toContain("section{Intro}");

    const ahead = await visualView(doc, doc.indexOf("section"));
    expect(press(ahead, "Delete", { altKey: true })).toBe(true);
    expect(ahead.state.doc.toString()).toBe("Text\n\\sub{Intro}\nMore");
    expect(ahead.state.selection.main.head).toBe(doc.indexOf("section"));

    const toEnd = await visualView(doc, doc.indexOf("section"));
    expect(press(toEnd, "k", { ctrlKey: true })).toBe(true);
    expect(balanced(toEnd.state.doc.toString())).toBe(true);
  });

  it("deletes a word with a symbol drawn inside it whole", async () => {
    for (const word of ["G\\\"odel", "hyphen\\-ation"]) {
      const doc = `A ${word}`;
      const view = await visualView(doc, doc.length);
      expect(press(view, "Backspace", { altKey: true })).toBe(true);
      expect(view.state.doc.toString()).toBe("A ");
    }
  });

  it("keeps typewriter text's dashes and quotes as typed", async () => {
    const view = await visualView("A \\texttt{--verbose ``x''} B", 0);
    expect(view.contentDOM.querySelector(".lx-tex-mono")?.textContent).toBe("--verbose ``x''");
  });

  it("still unwraps a heading when a selection deletes only its closing brace", async () => {
    const doc = "\\section{Introduction}\nWe study";
    const view = await visualView(doc, doc.length);
    view.dispatch({ selection: { anchor: doc.indexOf("duction"), head: doc.indexOf(" study") } });
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("Intro study");
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
