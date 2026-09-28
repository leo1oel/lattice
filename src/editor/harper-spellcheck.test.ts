import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

// The engine itself now lives in Rust (src-tauri/src/harper.rs, covered by
// cargo tests); these tests exercise the JS layer's real responsibilities —
// masking, span filtering, action building — against a miniature engine fake
// that mirrors harper-core's observable behavior for the fixtures below.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { text?: string; projectWords?: string[] }) => {
    if (command !== "harper_lint") throw new Error(`unexpected command ${command}`);
    const text = args?.text ?? "";
    const projectWords = (args?.projectWords ?? []).map((word) => word.toLocaleLowerCase());
    const misspelled = new Map([
      ["introductiom", "introduction"], ["sentnce", "sentence"], ["takeawayaccent", "takeaway accent"], ["zylorph", "sylph"],
    ]);
    const lints = [...text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)].flatMap((match) => {
      const word = match[0].toLocaleLowerCase();
      const replacement = misspelled.get(word);
      if (!replacement || projectWords.includes(word)) return [];
      const suggestions = [{ kind: "replace", replacement }];
      return [{ start: match.index, end: match.index + match[0].length, kind: "Spelling", message: `Did you mean “${replacement}”?`, suggestions }];
    });
    // Sentence capitalization, like harper's lint: only when the sentence
    // actually starts the text (masked math leaves leading spaces).
    const first = text.match(/^[a-z][A-Za-z'’-]*/);
    if (first) {
      const message = "This sentence does not start with a capital letter";
      lints.push({ start: 0, end: first[0].length, kind: "Capitalization", message, suggestions: [] });
    }
    return lints;
  }),
}));

import {
  createHarperDiagnostic,
  harperDiagnostics,
  harperDictionaryChanged,
  harperLintWindow,
  HARPER_WINDOW_THRESHOLD,
  maskLatexForHarper,
} from "./harper-spellcheck";

const spelling = (input: Partial<Parameters<typeof createHarperDiagnostic>[0]>) =>
  createHarperDiagnostic({ from: 0, to: 0, message: "Unknown word.", kind: "Spelling", suggestions: [], ...input });
const spans = (source: string, diagnostics: { from: number; to: number }[]) =>
  diagnostics.map((diagnostic) => source.slice(diagnostic.from, diagnostic.to));

const PREAMBLE = [
  "\\documentclass{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\title{A Clean Title}",
  "\\begin{document}",
  "This is introductiom.",
  "\\end{document}",
].join("\n");
const COLOR_PREAMBLE = [
  "\\documentclass[11pt]{article}",
  "\\usepackage{fontspec}",
  "\\setmainfont[UprightFont={*-Regular},BoldFont={*-Bold}]{Songti SC}",
  "\\definecolor{takeawayaccent}{HTML}{315B78}",
  "\\hypersetup{linkcolor=takeawayaccent}",
  "\\newtcolorbox{takeawaybox}[1]{colframe=takeawayaccent}",
  "\\title{A Clean Title}",
  "\\begin{document}",
  "\\pagecolor{takeawaybackground}",
  "\\color{takeawayaccent}",
  "This is introductiom.",
  "\\end{document}",
].join("\n");
const TABLE = [
  "This is introductiom.",
  "",
  "| Method | Description |",
  "| --- | --- |",
  "| Baseline | This table cell contains many words that Harper should never treat as one long sentence |",
  "| Proposed | Another table cell with additional prose that belongs to the table |",
  "",
  "Visible prose remains available to Harper.",
].join("\n");
const CAPITALIZATION = /does not start with a capital letter/i;

describe("Harper prose spellcheck", () => {
  it("reports a real spelling diagnostic for misspelled prose", async () => {
    const diagnostics = await harperDiagnostics("This is introductiom.");
    expect(diagnostics.some((diagnostic) => diagnostic.source === "Harper")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.from === 8 && diagnostic.to === 20)).toBe(true);
  });

  it.each([
    ["masked LaTeX commands as repeated spaces", PREAMBLE, "takeawayaccent"],
    ["preamble configuration and document-level color setup", COLOR_PREAMBLE, "takeawayaccent"],
    ["Markdown table cells as prose", TABLE, "table cell"],
  ])("does not report %s", async (_name, source, hidden) => {
    const diagnostics = await harperDiagnostics(source);
    const flagged = spans(source, diagnostics);
    expect(diagnostics.some((diagnostic) => /spaces where there should be only one/i.test(diagnostic.message))).toBe(false);
    expect(flagged).toContain("introductiom");
    expect(flagged.some((span) => span.includes(hidden))).toBe(false);
  });

  it.each([
    ["does not require uppercase prose after math that opens a sentence", "$g\\equiv1$ shares the update (and $\\Delta$ can be merged into $W$ at inference).", false],
    ["still reports an ordinary lowercase sentence start", "this sentence starts with lowercase prose.", true],
  ])("%s", async (_name, source, reported) => {
    const diagnostics = await harperDiagnostics(source);
    expect(diagnostics.some((diagnostic) => CAPITALIZATION.test(diagnostic.message))).toBe(reported);
  });

  it.each([
    ["author names and LaTeX package and bibliography identifiers",
      ["\\usepackage{neurips_2025}", "\\author{Yimimg Zhaoo}", "\\bibliographystyle{plainnatt}", "\\title{A sentnce}"].join("\n"),
      ["neurips_2025", "Yimimg Zhaoo", "plainnatt"], ["A sentnce"]],
    ["preamble configuration and document-level color setup", COLOR_PREAMBLE,
      ["UprightFont", "takeawayaccent", "takeawaybackground"], ["A Clean Title", "This is introductiom."]],
    ["technical command arguments without hiding their rendered prose", [
      "\\textcolor{takeawayaccent}{A sentnce.}",
      "\\colorbox{takeawaybackground}{Visible prose.}",
      "\\fcolorbox{takeawayaccent}{takeawaybackground}{More prose.}",
      "\\href{https://exmple.test}{Readable link.}",
    ].join("\n"), ["takeaway", "exmple.test"], ["A sentnce.", "Visible prose.", "More prose.", "Readable link."]],
    ["Markdown tables without hiding surrounding prose", TABLE,
      ["Method", "Baseline"], ["This is introductiom.", "Visible prose remains available to Harper."]],
    ["LaTeX commands, citations, math, and comments",
      "\\section{A sentnce} cites \\citep{smith2024}. $x + y$ % hidden typo\nVisible prose.",
      ["smith2024", "x + y", "hidden typo"], ["sentnce", "Visible prose"]],
  ])("masks %s while preserving source offsets", (_name, source, hidden, visible) => {
    const { prose } = maskLatexForHarper(source);
    expect(prose).toHaveLength(source.length);
    for (const text of hidden) expect(prose).not.toContain(text);
    for (const text of visible) expect(prose.slice(source.indexOf(text), source.indexOf(text) + text.length)).toBe(text);
  });

  it("accepts words from the project dictionary", async () => {
    const source = "Zylorph presents the result.";
    expect(spans(source, await harperDiagnostics(source))).toContain("Zylorph");
    expect(spans(source, await harperDiagnostics(source, { projectWords: ["Zylorph"] }))).not.toContain("Zylorph");
  });

  it("offers to add a misspelling to the project dictionary", async () => {
    const add = vi.fn().mockResolvedValue(true);
    let refreshes = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: "Zylorph",
        extensions: EditorView.updateListener.of((update) => {
          refreshes += update.transactions.filter((transaction) =>
            transaction.effects.some((effect) => effect.is(harperDictionaryChanged))).length;
        }),
      }),
    });
    const diagnostic = spelling({ to: 6, suggestions: [], projectWord: "Zylorph", onAddProjectWord: add });
    diagnostic.actions?.[0]?.apply(view, 0, 6);
    expect(diagnostic.actions?.[0]?.name).toBe("Add “Zylorph” to project dictionary");
    expect(add).toHaveBeenCalledWith("Zylorph");
    await vi.waitFor(() => expect(refreshes).toBe(1));
    view.destroy();
  });

  it("shows only the best correction plus the project dictionary action", () => {
    const suggestions = ["first", "second", "third"].map((replacement) => ({ kind: "replace" as const, replacement }));
    const diagnostic = spelling({ to: 5, suggestions, projectWord: "frist", onAddProjectWord: () => true });
    expect(diagnostic.actions?.map((action) => action.name)).toEqual(["Replace with “first”", "Add “frist” to project dictionary"]);
  });

  it("applies Harper replacements at CodeMirror's current diagnostic range", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "A sentnce." }) });
    const diagnostic = spelling({ from: 2, to: 9, suggestions: [{ kind: "replace", replacement: "sentence" }] });
    diagnostic.actions?.[0]?.apply(view, diagnostic.from, diagnostic.to);
    expect(view.state.doc.toString()).toBe("A sentence.");
    expect(diagnostic.source).toBe("Harper");
    expect(diagnostic.severity).toBe("error");
    view.destroy();
  });

  it("windows Harper linting only above the size threshold", () => {
    const smallView = new EditorView({ parent: document.body, state: EditorState.create({ doc: "short document\n".repeat(10) }) });
    expect(harperLintWindow(smallView)).toBeNull();
    smallView.destroy();

    const line = "a sentence that repeats across the large fixture document\n";
    const doc = line.repeat(Math.ceil((HARPER_WINDOW_THRESHOLD + 50_000) / line.length));
    const largeView = new EditorView({ parent: document.body, state: EditorState.create({ doc }) });
    const window = harperLintWindow(largeView)!;
    // A strict sub-range of the document, snapped to line boundaries.
    expect(window.from).toBeGreaterThanOrEqual(0);
    expect(window.to).toBeLessThanOrEqual(doc.length);
    expect(window.to - window.from).toBeLessThan(doc.length);
    expect(largeView.state.doc.lineAt(window.from).from).toBe(window.from);
    expect(largeView.state.doc.lineAt(window.to).to).toBe(window.to);
    // Every visible range is covered, margins included.
    for (const range of largeView.visibleRanges) {
      expect(window.from).toBeLessThanOrEqual(range.from);
      expect(window.to).toBeGreaterThanOrEqual(range.to);
    }
    largeView.destroy();
  });
});
