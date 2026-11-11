import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { deleteGroupBackward, undo } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { latex } from "../latex-language";
import { balanced, host, press, visualView } from "./visual-test-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
// Lattice runs on macOS, and CodeMirror reads the platform once, when it loads: its keymaps here are the Mac ones.
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

describe("LaTeX Visual mode deletion", () => {
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

  // A chip shows its source while the caret is at its edge; its tokens are stepped over as a revealed heading's are.
  for (const chip of ["\\cite{knuth}", "\\citep[p.~3]{knuth}", "\\ref{knuth}", "\\label{knuth}"]) {
    it(`steps over ${chip}'s braces from either edge, never deleting one alone, and one undo restores it`, async () => {
      const doc = `A ${chip} B`;
      const end = doc.indexOf(" B");
      const keyed = (key: string) => doc.replace("{knuth}", `{${key}}`);
      const cases = [
        { anchor: end, key: "Backspace", expected: keyed("knut"), caret: end - 1 },
        { anchor: 2, key: "Delete", expected: keyed("nuth"), caret: 2 },
      ];
      for (const { anchor, key, expected, caret } of cases) {
        const view = await visualView(doc, anchor);
        expect(view.contentDOM.querySelector(".lx-tex-chip")).toBeNull();
        expect(press(view, key)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        expect(view.state.selection.main.head).toBe(caret);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc);
      }
    });
  }

  it("removes an empty key command whole from either side, one undo restoring it, and empties a chip into one", async () => {
    for (const command of ["\\cite{}", "\\citep[p.~3]{ }", "\\ref{}", "\\label{}"]) {
      const doc = `A ${command} B`;
      const end = doc.indexOf(" B");
      for (const { anchor, key } of [{ anchor: end, key: "Backspace" }, { anchor: 2, key: "Delete" }]) {
        const view = await visualView(doc, anchor);
        expect(press(view, key)).toBe(true);
        expect(view.state.doc.toString()).toBe("A  B");
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc);
      }
    }
    const doc = "A \\cite{ab} B";
    const view = await visualView(doc, doc.indexOf(" B"));
    for (const expected of ["A \\cite{a} B", "A \\cite{} B", "A  B"]) {
      expect(press(view, "Backspace")).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(balanced(view.state.doc.toString())).toBe(true);
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

  it("still unwraps a heading when a selection deletes only its closing brace", async () => {
    const doc = "\\section{Introduction}\nWe study";
    const view = await visualView(doc, doc.length);
    view.dispatch({ selection: { anchor: doc.indexOf("duction"), head: doc.indexOf(" study") } });
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("Intro study");
  });
});
