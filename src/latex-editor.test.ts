import { completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  beginEnvironmentClose,
  bibliographyEntryLine,
  citationCompletionRange,
  citationHoverTarget,
  citationTooltipSpace,
  countWords,
  definitionTargetAt,
  enclosingEnvironment,
  enclosingEnvironmentRange,
  includeCompletionRange,
  includeHoverTarget,
  indexDiagnostics,
  matchingEnvironmentTarget,
  mergeReferences,
  parseLocalLabels,
  parseLocalMacros,
  parseGraphicsPaths,
  pathDiagnostics,
  toggleLineComments,
  renameEnvironmentAt,
  sortSelectedLines,
  symbolAt,
  latexEditorExtensions,
  latexLanguageOptions,
  selectionVisibilityExtension,
  referenceCompletionRange,
  referenceHoverTarget,
  shouldInsertCommandBraces,
  structureDiagnostics,
  textStats,
  transformCase,
  wrapCommentRegion,
  wrapEnvironment,
  wrapRange,
} from "./latex-editor";

describe("LaTeX citation editing", () => {
  it("soft-wraps long logical lines instead of scrolling horizontally", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "A single logical line that can wrap across several visual rows.",
        extensions: latexEditorExtensions([]),
      }),
    });
    expect(view.contentDOM).toHaveClass("cm-lineWrapping");
    view.destroy();
  });

  it("marks the editor when a text range is selected so active-line fill can clear", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "hello world",
        extensions: selectionVisibilityExtension(),
      }),
    });
    expect(view.dom.classList.contains("cm-lattice-has-selection")).toBe(false);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(view.dom.classList.contains("cm-lattice-has-selection")).toBe(true);
    view.dispatch({ selection: { anchor: 5, head: 5 } });
    expect(view.dom.classList.contains("cm-lattice-has-selection")).toBe(false);
    view.destroy();
  });

  it("keeps package linting off while enabling hover documentation", () => {
    expect(latexLanguageOptions).toMatchObject({
      enableLinting: false,
      enableTooltips: true,
    });
  });

  it("adds braces after citation and reference commands", () => {
    expect(shouldInsertCommandBraces("Text \\cite")).toBe(true);
    expect(shouldInsertCommandBraces("See \\citet")).toBe(true);
    expect(shouldInsertCommandBraces("Equation \\eqref")).toBe(true);
    expect(shouldInsertCommandBraces("not a command cite")).toBe(false);
  });

  it("completes the current key inside citation braces", () => {
    expect(citationCompletionRange("Text \\cite{", 11)).toEqual({ from: 11, query: "" });
    expect(citationCompletionRange("Text \\cite{vas", 14)).toEqual({ from: 11, query: "vas" });
    expect(citationCompletionRange("Text \\cite{first,", 17)).toEqual({ from: 17, query: "" });
    expect(citationCompletionRange("Text \\cite{first, trans", 23)).toEqual({ from: 18, query: "trans" });
    expect(citationCompletionRange("Text \\section{intro", 19)).toBeNull();
  });

  it("identifies the exact bibliography key hovered inside a citation", () => {
    const source = "Evidence \\citep{vaswani2017attention, dosovitskiy2021image}.";
    const first = source.indexOf("vaswani") + 3;
    const second = source.indexOf("dosovitskiy") + 4;
    expect(citationHoverTarget(source, first)?.key).toBe("vaswani2017attention");
    expect(citationHoverTarget(source, second)?.key).toBe("dosovitskiy2021image");
    expect(citationHoverTarget("Plain text", 3)).toBeNull();
  });

  it("keeps citation tooltips inside the editor boundary", () => {
    expect(citationTooltipSpace({ left: 320, right: 720, top: 80, bottom: 680 })).toEqual({
      left: 328,
      right: 712,
      top: 88,
      bottom: 672,
    });
  });

  it("identifies figure, table, and equation labels inside reference commands", () => {
    const source = "See \\ref{fig:model}, \\cref{tab:results, eq:loss}, and \\autoref{sec:intro}.";
    expect(referenceHoverTarget(source, source.indexOf("fig:model") + 3)?.label).toBe("fig:model");
    expect(referenceHoverTarget(source, source.indexOf("tab:results") + 4)?.label).toBe("tab:results");
    expect(referenceHoverTarget(source, source.indexOf("eq:loss") + 3)?.label).toBe("eq:loss");
    expect(referenceHoverTarget(source, source.indexOf("sec:intro") + 3)?.label).toBe("sec:intro");
    expect(referenceHoverTarget("Plain text", 3)).toBeNull();
  });

  it("completes project paths inside input, include, and includegraphics", () => {
    expect(includeCompletionRange("\\input{", 7)).toEqual({ from: 7, query: "" });
    expect(includeCompletionRange("\\include{sec", 12)).toEqual({ from: 9, query: "sec" });
    expect(includeCompletionRange("\\includegraphics[width=\\linewidth]{fig", 37)).toEqual({ from: 34, query: "fig" });
    expect(includeCompletionRange("\\section{intro", 14)).toBeNull();
  });

  it("resolves include paths for go-to-definition", () => {
    const source = "\\input{sections/method}\n\\include{appendix}";
    expect(includeHoverTarget(source, source.indexOf("method") + 2)?.path).toBe("sections/method");
    expect(definitionTargetAt(source, source.indexOf("appendix") + 2, [])).toEqual({
      kind: "include",
      path: "appendix.tex",
    });
  });

  it("resolves includegraphics paths for go-to-definition", () => {
    const source = "\\includegraphics[width=\\linewidth]{figures/plot}";
    expect(definitionTargetAt(source, source.indexOf("plot") + 1, [], ["figures/plot.png"])).toEqual({
      kind: "asset",
      path: "figures/plot.png",
    });
  });

  it("inserts braces in the editor and keeps an existing pair", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "\\cit",
        selection: { anchor: 4 },
        extensions: latexEditorExtensions(["vaswani2017attention"]),
      }),
    });
    view.dispatch({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(view.state.doc.toString()).toBe("\\cite{}");
    view.destroy();

    const existing = new EditorView({
      parent,
      state: EditorState.create({
        doc: "\\cit{}",
        selection: { anchor: 4 },
        extensions: latexEditorExtensions([]),
      }),
    });
    existing.dispatch({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(existing.state.doc.toString()).toBe("\\cite{}");
    existing.destroy();
  });

  it("adds braces when a citation command is accepted from completion", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "\\ci",
        selection: { anchor: 3 },
        extensions: latexEditorExtensions([]),
      }),
    });
    view.dispatch({
      changes: { from: 0, to: 3, insert: "\\cite" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.complete"),
    });
    expect(view.state.doc.toString()).toBe("\\cite{}");
    view.destroy();
  });

  it("shows citation keys immediately for an empty slot and after a comma", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "\\cit",
        selection: { anchor: 4 },
        extensions: latexEditorExtensions(["vaswani2017attention", "dosovitskiy2021image"]),
      }),
    });
    view.dispatch({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(currentCompletions(view.state).map((completion) => completion.label)).toEqual([
      "dosovitskiy2021image",
      "vaswani2017attention",
    ]);

    view.dispatch({
      changes: { from: 6, insert: "first," },
      selection: { anchor: 12 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(currentCompletions(view.state).map((completion) => completion.label)).toContain("vaswani2017attention");
    view.destroy();
  });

  it("completes labels inside reference commands", () => {
    expect(referenceCompletionRange("See \\ref{", 9)).toEqual({ from: 9, query: "" });
    expect(referenceCompletionRange("See \\cref{fig:", 14)).toEqual({ from: 10, query: "fig:" });
  });

  it("warns about unknown citation keys and labels", () => {
    const diagnostics = indexDiagnostics(
      "See \\citep{missing} and \\ref{fig:gone}.",
      ["known"],
      [{ label: "fig:model", kind: "figure", title: "Model", snippet: "", path: "main.tex", line: 1 }],
    );
    expect(diagnostics.map((item) => item.message)).toEqual([
      "Unknown citation key “missing”.",
      "Unknown label “fig:gone”.",
    ]);
  });

  it("resolves symbols under the cursor for find-references and rename", () => {
    const source = "See \\ref{fig:model} and \\label{fig:model} plus \\citep{vaswani2017}.";
    expect(symbolAt(source, source.indexOf("fig:model") + 2)).toEqual({ kind: "label", label: "fig:model" });
    expect(symbolAt(source, source.indexOf("\\label{fig:model}") + 10)).toEqual({ kind: "label", label: "fig:model" });
    expect(symbolAt(source, source.indexOf("vaswani") + 2)).toEqual({ kind: "citation", key: "vaswani2017" });
  });

  it("auto-closes begin environments and skips existing ends", () => {
    expect(beginEnvironmentClose("\\begin{align}", "")).toEqual({
      insert: "\n  \n\\end{align}",
      cursorOffset: 3,
    });
    expect(beginEnvironmentClose("\\begin{align}", "\n\\end{align}")).toBeNull();
    expect(beginEnvironmentClose("\\begin{align*}", "")?.insert).toContain("\\end{align*}");
  });

  it("flags unmatched environments and duplicate labels", () => {
    const diagnostics = structureDiagnostics(
      "\\begin{figure}\n\\label{fig:a}\n\\label{fig:a}\n\\end{table}\n\\begin{equation}\n",
    );
    expect(diagnostics.map((item) => item.message)).toEqual([
      "Expected \\end{figure}, found \\end{table}.",
      "Unclosed \\begin{equation}.",
      "Duplicate label “fig:a”.",
    ]);
  });

  it("flags unclosed math delimiters", () => {
    const diagnostics = structureDiagnostics("Hello $x + y and $$a");
    expect(diagnostics.some((item) => item.message.includes("Unclosed display math $$"))).toBe(true);
    expect(diagnostics.some((item) => item.message.includes("Unclosed inline math $"))).toBe(true);
  });

  it("warns about unused labels and bibliography keys", () => {
    const diagnostics = indexDiagnostics(
      "\\label{fig:dead} @article{dead, title={X},}",
      ["dead"],
      [{ label: "fig:dead", kind: "figure", title: "", snippet: "", path: "main.tex", line: 1 }],
      ["fig:dead"],
      ["dead"],
      [],
      "main.tex",
    );
    expect(diagnostics.map((item) => item.message)).toEqual([
      "Unused label “fig:dead”.",
      "Unused citation key “dead”.",
    ]);
  });

  it("warns when a label is also defined in another file", () => {
    const diagnostics = indexDiagnostics(
      "\\label{fig:shared}",
      [],
      [
        { label: "fig:shared", kind: "figure", title: "", snippet: "", path: "main.tex", line: 1 },
        { label: "fig:shared", kind: "figure", title: "", snippet: "", path: "sections/a.tex", line: 3 },
      ],
      [],
      [],
      [],
      "main.tex",
    );
    expect(diagnostics.some((item) => item.message.includes("also defined in sections/a.tex"))).toBe(true);
  });

  it("wraps and renames environments", () => {
    expect(wrapEnvironment("x", 0, 1, "equation").insert).toContain("\\begin{equation}");
    const source = "\\begin{align}x\\end{align}";
    const edits = renameEnvironmentAt(source, 2, "align*");
    expect(edits).toEqual([
      { from: 0, to: "\\begin{align}".length, insert: "\\begin{align*}" },
      { from: source.indexOf("\\end{align}"), to: source.length, insert: "\\end{align*}" },
    ]);
  });

  it("merges live labels from the dirty buffer", () => {
    const merged = mergeReferences(
      [{ label: "fig:old", kind: "figure", title: "", snippet: "", path: "other.tex", line: 1 }],
      "main.tex",
      parseLocalLabels("main.tex", "\\label{fig:new}"),
    );
    expect(merged.map((item) => item.label).sort()).toEqual(["fig:new", "fig:old"]);
  });

  it("preserves figure preview metadata when overlaying dirty labels", () => {
    const merged = mergeReferences(
      [{
        label: "fig:native-umm",
        kind: "figure",
        title: "Native UMM",
        snippet: "\\includegraphics{figures/native-umm.pdf}",
        path: "main.tex",
        line: 12,
        imagePath: "figures/native-umm.pdf",
      }],
      "main.tex",
      parseLocalLabels("main.tex", "\\label{fig:native-umm}"),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.imagePath).toBe("figures/native-umm.pdf");
    expect(merged[0]?.kind).toBe("figure");
    expect(merged[0]?.title).toBe("Native UMM");
  });

  it("flags missing include and graphics paths", () => {
    const created: string[] = [];
    const diagnostics = pathDiagnostics(
      "\\input{missing}\n\\includegraphics{figures/gone.pdf}\n\\input{sections/ok}",
      ["sections/ok.tex", "figures/kept.pdf"],
      [],
      (path) => {
        created.push(path);
      },
    );
    expect(diagnostics.map((item) => item.message)).toEqual([
      "Missing file “missing”.",
      "Missing figure “figures/gone.pdf”.",
    ]);
    diagnostics[0]?.actions?.[0]?.apply(null as never, 0, 0);
    expect(created).toEqual(["missing.tex"]);
  });

  it("resolves includegraphics paths wrapped in detokenize", () => {
    const diagnostics = pathDiagnostics(
      "\\includegraphics[width=\\linewidth]{\\detokenize{figures/native-umm-converted.pdf}}",
      ["figures/native-umm-converted.pdf"],
    );
    expect(diagnostics).toEqual([]);
  });

  it("resolves figures via graphicspath", () => {
    const roots = parseGraphicsPaths(["\\graphicspath{{figs/}{images/}}\n"]);
    expect(roots).toEqual(["figs", "images"]);
    expect(pathDiagnostics(
      "\\includegraphics{plot}",
      ["figs/plot.pdf", "images/other.png"],
      roots,
    )).toEqual([]);
    expect(pathDiagnostics(
      "\\includegraphics{missing}",
      ["figs/plot.pdf"],
      roots,
    ).map((item) => item.message)).toEqual(["Missing figure “missing”."]);
  });

  it("toggles % line comments", () => {
    const source = "alpha\nbeta\ngamma\n";
    const commented = toggleLineComments(source, 6, 10);
    expect(commented.insert).toBe("% beta");
    const restored = toggleLineComments(
      `${source.slice(0, commented.from)}${commented.insert}${source.slice(commented.to)}`,
      commented.from,
      commented.from + commented.insert.length,
    );
    expect(restored.insert).toBe("beta");
  });

  it("parses project macros for completion", () => {
    const macros = parseLocalMacros(["\\newcommand{\\loss}{L}\n\\newenvironment{proofbox}{}{}\n"]);
    expect(macros.map((item) => item.label)).toEqual(["\\loss", "\\begin{proofbox}"]);
  });

  it("counts words for the editor status bar", () => {
    expect(countWords("Hello, world — and pre-trained models.")).toBe(5);
    expect(countWords("")).toBe(0);
  });

  it("wraps a selection or empty cursor for bold and math", () => {
    expect(wrapRange("hello world", 0, 5, "\\textbf{", "}")).toEqual({
      from: 0,
      to: 5,
      insert: "\\textbf{hello}",
      cursorFrom: 8,
      cursorTo: 13,
    });
    expect(wrapRange("x", 0, 0, "$", "$")).toEqual({
      from: 0,
      to: 0,
      insert: "$$",
      cursorFrom: 1,
      cursorTo: 1,
    });
  });

  it("jumps between matching begin and end environments", () => {
    const source = "\\begin{figure}\\begin{center}x\\end{center}\\end{figure}";
    const beginFigure = source.indexOf("\\begin{figure}");
    const endFigure = source.indexOf("\\end{figure}");
    const beginCenter = source.indexOf("\\begin{center}");
    expect(matchingEnvironmentTarget(source, beginFigure + 2)).toEqual({
      from: endFigure,
      to: endFigure + "\\end{figure}".length,
    });
    expect(matchingEnvironmentTarget(source, endFigure + 2)).toEqual({
      from: beginFigure,
      to: beginFigure + "\\begin{figure}".length,
    });
    expect(matchingEnvironmentTarget(source, beginCenter + 2)).toEqual({
      from: source.indexOf("\\end{center}"),
      to: source.indexOf("\\end{center}") + "\\end{center}".length,
    });
    const inside = source.indexOf("x");
    expect(matchingEnvironmentTarget(source, inside)).toEqual({
      from: beginCenter,
      to: beginCenter + "\\begin{center}".length,
    });
    expect(enclosingEnvironment(source, inside)?.name).toBe("center");
    expect(enclosingEnvironmentRange(source, inside)).toEqual({
      from: beginCenter,
      to: source.indexOf("\\end{center}") + "\\end{center}".length,
    });
    expect(renameEnvironmentAt(source, inside, "quote")).toEqual([
      { from: beginCenter, to: beginCenter + "\\begin{center}".length, insert: "\\begin{quote}" },
      {
        from: source.indexOf("\\end{center}"),
        to: source.indexOf("\\end{center}") + "\\end{center}".length,
        insert: "\\end{quote}",
      },
    ]);
  });

  it("warns about duplicate bibliography keys", () => {
    const bib = "@article{same,\n  title={A},\n}\n@misc{same,\n  title={B},\n}\n";
    const diagnostics = structureDiagnostics(bib);
    expect(diagnostics.some((item) => item.message.includes('Duplicate bibliography key “same”'))).toBe(true);
  });

  it("opt-in spellcheck marks the contenteditable attributes", () => {
    const off = new EditorView({
      state: EditorState.create({ doc: "typo", extensions: latexEditorExtensions([]) }),
    });
    expect(off.contentDOM.getAttribute("spellcheck")).toBe("false");
    off.destroy();
    const on = new EditorView({
      state: EditorState.create({
        doc: "typo",
        extensions: latexEditorExtensions([], [], [], undefined, undefined, [], undefined, undefined, true),
      }),
    });
    expect(on.contentDOM.getAttribute("spellcheck")).toBe("true");
    expect(on.contentDOM.getAttribute("autocorrect")).toBe("on");
    on.destroy();
  });

  it("finds bibliography entry lines by key", () => {
    const bib = "@article{first,\n  title={A},\n}\n@inproceedings{second,\n  title={B},\n}\n";
    expect(bibliographyEntryLine(bib, "second")).toBe(4);
    expect(bibliographyEntryLine(bib, "missing")).toBeNull();
  });

  it("sorts selected lines and transforms case", () => {
    const source = "zeta\nalpha\nbeta\n";
    expect(sortSelectedLines(source, 0, source.length - 1)).toEqual({
      from: 0,
      to: 15,
      insert: "alpha\nbeta\nzeta",
    });
    expect(transformCase("hello WORLD", 0, 11, "title")?.insert).toBe("Hello World");
    expect(transformCase("Hello", 0, 5, "upper")?.insert).toBe("HELLO");
    expect(textStats("one two\nthree").words).toBe(3);
  });

  it("wraps selections in comment environments or iffalse blocks", () => {
    expect(wrapCommentRegion("draft", 0, 5, "comment-env").insert).toBe(
      "\\begin{comment}\ndraft\n\\end{comment}",
    );
    expect(wrapCommentRegion("draft", 0, 5, "iffalse").insert).toBe("\\iffalse\ndraft\n\\fi");
  });
});
