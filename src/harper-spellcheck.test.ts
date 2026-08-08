import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

// The engine itself now lives in Rust (src-tauri/src/harper.rs, covered by
// cargo tests); these tests exercise the JS layer's real responsibilities —
// masking, span filtering, action building — against a miniature engine fake
// that mirrors harper-core's observable behavior for the fixtures below.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command !== "harper_lint") throw new Error(`unexpected command ${command}`);
    const text = String(args?.text ?? "");
    const projectWords = (args?.projectWords as string[] | undefined ?? [])
      .map((word) => word.toLocaleLowerCase());
    const lints: unknown[] = [];
    const misspelled = new Map([
      ["introductiom", "introduction"],
      ["sentnce", "sentence"],
      ["yiming", "timing"],
    ]);
    for (const match of text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
      const word = match[0].toLocaleLowerCase();
      const replacement = misspelled.get(word);
      if (!replacement || projectWords.includes(word)) continue;
      lints.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: "Spelling",
        message: `Did you mean “${replacement}”?`,
        suggestions: [{ kind: "replace", replacement }],
      });
    }
    // Sentence capitalization, like harper's lint: only when the sentence
    // actually starts the text (masked math leaves leading spaces).
    const first = text.match(/^[a-z][A-Za-z'’-]*/);
    if (first) {
      lints.push({
        start: 0,
        end: first[0].length,
        kind: "Capitalization",
        message: "This sentence does not start with a capital letter",
        suggestions: [],
      });
    }
    return lints;
  }),
}));

import {
  createHarperDiagnostic,
  harperDiagnostics,
  harperDictionaryChanged,
  maskLatexForProse,
} from "./harper-spellcheck";

describe("Harper prose spellcheck", () => {
  it("reports a real spelling diagnostic for misspelled prose", async () => {
    const diagnostics = await harperDiagnostics("This is introductiom.");

    expect(diagnostics.some((diagnostic) => diagnostic.source === "Harper")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.from === 8 && diagnostic.to === 20)).toBe(true);
  });

  it("does not report masked LaTeX commands as repeated spaces", async () => {
    const source = [
      "\\documentclass{article}",
      "\\usepackage[utf8]{inputenc}",
      "\\title{A Clean Title}",
      "\\begin{document}",
      "This is introductiom.",
      "\\end{document}",
    ].join("\n");
    const diagnostics = await harperDiagnostics(source);

    expect(diagnostics.some((diagnostic) => /spaces where there should be only one/i.test(diagnostic.message))).toBe(false);
    expect(diagnostics.some((diagnostic) => source.slice(diagnostic.from, diagnostic.to) === "introductiom")).toBe(true);
  });

  it("does not require uppercase prose after math that opens a sentence", async () => {
    const source = "$g\\equiv1$ shares the update (and $\\Delta$ can be merged into $W$ at inference).";
    const diagnostics = await harperDiagnostics(source);

    expect(diagnostics.some((diagnostic) =>
      /does not start with a capital letter/i.test(diagnostic.message))).toBe(false);
  });

  it("still reports an ordinary lowercase sentence start", async () => {
    const diagnostics = await harperDiagnostics("this sentence starts with lowercase prose.");

    expect(diagnostics.some((diagnostic) =>
      /does not start with a capital letter/i.test(diagnostic.message))).toBe(true);
  });

  it("masks author names and LaTeX package and bibliography identifiers", () => {
    const source = [
      "\\usepackage{neurips_2025}",
      "\\author{Yimimg Zhaoo}",
      "\\bibliographystyle{plainnatt}",
      "\\title{A sentnce}",
    ].join("\n");
    const prose = maskLatexForProse(source);

    expect(prose).not.toContain("neurips_2025");
    expect(prose).not.toContain("Yimimg Zhaoo");
    expect(prose).not.toContain("plainnatt");
    expect(prose).toContain("A sentnce");
  });

  it("skips Markdown tables without hiding surrounding prose", async () => {
    const source = [
      "This is introductiom.",
      "",
      "| Method | Description |",
      "| --- | --- |",
      "| Baseline | This table cell contains many words that Harper should never treat as one long sentence |",
      "| Proposed | Another table cell with additional prose that belongs to the table |",
      "",
      "Visible prose remains available to Harper.",
    ].join("\n");
    const prose = maskLatexForProse(source);
    const diagnostics = await harperDiagnostics(source);

    expect(prose).toHaveLength(source.length);
    expect(prose).not.toContain("Method");
    expect(prose).not.toContain("Baseline");
    expect(prose).toContain("This is introductiom.");
    expect(prose).toContain("Visible prose remains available to Harper.");
    expect(diagnostics.some((diagnostic) =>
      source.slice(diagnostic.from, diagnostic.to) === "introductiom")).toBe(true);
    expect(diagnostics.some((diagnostic) =>
      source.slice(diagnostic.from, diagnostic.to).includes("table cell"))).toBe(false);
  });

  it("accepts words from the project dictionary", async () => {
    const source = "Yiming presents the result.";
    const before = await harperDiagnostics(source);
    const after = await harperDiagnostics(source, { projectWords: ["Yiming"] });

    expect(before.some((diagnostic) => source.slice(diagnostic.from, diagnostic.to) === "Yiming")).toBe(true);
    expect(after.some((diagnostic) => source.slice(diagnostic.from, diagnostic.to) === "Yiming")).toBe(false);
  });

  it("offers to add a misspelling to the project dictionary", async () => {
    const add = vi.fn().mockResolvedValue(true);
    let refreshes = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: "Yiming",
        extensions: EditorView.updateListener.of((update) => {
          if (update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(harperDictionaryChanged)))) {
            refreshes += 1;
          }
        }),
      }),
    });
    const diagnostic = createHarperDiagnostic({
      from: 0,
      to: 6,
      message: "Unknown word.",
      kind: "Spelling",
      suggestions: [],
      projectWord: "Yiming",
      onAddProjectWord: add,
    });

    diagnostic.actions?.[0]?.apply(view, 0, 6);
    expect(diagnostic.actions?.[0]?.name).toBe("Add “Yiming” to project dictionary");
    expect(add).toHaveBeenCalledWith("Yiming");
    await vi.waitFor(() => expect(refreshes).toBe(1));
    view.destroy();
  });

  it("shows only the best correction plus the project dictionary action", () => {
    const diagnostic = createHarperDiagnostic({
      from: 0,
      to: 5,
      message: "Unknown word.",
      kind: "Spelling",
      suggestions: [
        { kind: "replace", replacement: "first" },
        { kind: "replace", replacement: "second" },
        { kind: "replace", replacement: "third" },
      ],
      projectWord: "frist",
      onAddProjectWord: () => true,
    });

    expect(diagnostic.actions?.map((action) => action.name)).toEqual([
      "Replace with “first”",
      "Add “frist” to project dictionary",
    ]);
  });

  it("preserves source offsets while hiding LaTeX commands, citations, math, and comments", () => {
    const source = "\\section{A sentnce} cites \\citep{smith2024}. $x + y$ % hidden typo\nVisible prose.";
    const prose = maskLatexForProse(source);

    expect(prose).toHaveLength(source.length);
    expect(prose.slice(source.indexOf("sentnce"), source.indexOf("sentnce") + 7)).toBe("sentnce");
    expect(prose).not.toContain("smith2024");
    expect(prose).not.toContain("x + y");
    expect(prose).not.toContain("hidden typo");
    expect(prose).toContain("Visible prose");
  });

  it("applies Harper replacements at CodeMirror's current diagnostic range", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "A sentnce." }) });
    const diagnostic = createHarperDiagnostic({
      from: 2,
      to: 9,
      message: "Did you mean sentence?",
      kind: "Spelling",
      suggestions: [{ kind: "replace", replacement: "sentence" }],
    });

    diagnostic.actions?.[0]?.apply(view, diagnostic.from, diagnostic.to);
    expect(view.state.doc.toString()).toBe("A sentence.");
    expect(diagnostic.source).toBe("Harper");
    expect(diagnostic.severity).toBe("error");
    view.destroy();
  });
});
