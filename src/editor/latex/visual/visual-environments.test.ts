import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { documentBounds, environmentIndex, openEnvironments } from "./visual-environments";

const stateOf = (doc: string) => EditorState.create({ doc, extensions: environmentIndex });
/** Every token in the index, as text, for comparing an edited index with one built from scratch. */
const tokens = (state: EditorState) => {
  const found: string[] = [];
  state.field(environmentIndex).between(0, state.doc.length, (from, to) => void found.push(`${from}:${state.sliceDoc(from, to)}`));
  return found;
};

const DOC = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\begin{itemize}",
  "  \\item a % \\begin{enumerate} in a comment",
  "  \\begin{enumerate}",
  "    \\item b",
  "  \\end{enumerate}",
  "\\end{itemize}",
  "\\begin{verbatim}",
  "\\begin{figure}",
  "\\end{verbatim}",
  "Costs 5\\% \\\\begin{x} no.",
  "\\end{document}",
].join("\n");

describe("environment index", () => {
  it("indexes the tokens TeX reads, not those in comments or after an escaped backslash", () => {
    expect(tokens(stateOf(DOC)).map((token) => token.split(":").slice(1).join(":"))).toEqual([
      "\\begin{document}", "\\begin{itemize}", "\\begin{enumerate}", "\\end{enumerate}", "\\end{itemize}",
      "\\begin{verbatim}", "\\begin{figure}", "\\end{verbatim}", "\\end{document}",
    ]);
  });

  it("knows what is open at a position, reading a verbatim block's tokens as its text", () => {
    const state = stateOf(DOC);
    expect(openEnvironments(state, DOC.indexOf("\\item b")).map((environment) => environment.name)).toEqual(["document", "itemize", "enumerate"]);
    expect(openEnvironments(state, DOC.indexOf("Costs")).map((environment) => environment.name)).toEqual(["document"]);
    expect(documentBounds(state)).toEqual({
      begin: { from: DOC.indexOf("\\begin{document}"), to: DOC.indexOf("\\begin{document}") + "\\begin{document}".length },
      end: { from: DOC.indexOf("\\end{document}"), to: DOC.indexOf("\\end{document}") + "\\end{document}".length },
    });
  });

  it("stays what a fresh scan finds through edits that make, break and move tokens", () => {
    let state = stateOf(DOC);
    const edits: Array<(doc: string) => { from: number; to?: number; insert?: string }> = [
      (doc) => ({ from: doc.indexOf("\\begin{enumerate}") + 7, to: doc.indexOf("\\begin{enumerate}") + 8 }),
      (doc) => ({ from: doc.indexOf("\\begin{itemize}"), insert: "\\begin{center}\n" }),
      (doc) => ({ from: doc.indexOf("% \\begin"), to: doc.indexOf("% \\begin") + 1 }),
      (doc) => ({ from: doc.indexOf("Costs"), insert: "\\end{center}\n\\begin{quote}x\\end{quote}\n" }),
      (doc) => ({ from: 0, to: doc.indexOf("\\begin{verbatim}") }),
      (doc) => ({ from: doc.length, insert: "\n\\begin{itemize}\\item z\\end{itemize}" }),
    ];
    for (const edit of edits) {
      state = state.update({ changes: edit(state.doc.toString()) }).state;
      expect(tokens(state)).toEqual(tokens(stateOf(state.doc.toString())));
    }
  });
});
