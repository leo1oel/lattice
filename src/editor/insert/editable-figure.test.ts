import { nextSnippetField, snippet } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  editableFigureBlockSnippet, editableFigureChanges, editableFigureFromHtml, editableFigureInclude, figureSourcePath, includedTexPaths,
  insideFigureHolder, isDefinitionsOnly, knownGraphicsPath, missingPreambleInsertions, pastesFigureBlock, preambleFiles, preambleNeedsConfirmation, type ImportedFigure,
} from "./editable-figure";

const manifest = {
  version: 1,
  name: "scheme",
  source: { name: "scheme.reactio", data: "e30=" },
  outputs: [{ name: "scheme.pdf", data: "JQ==" }, { name: "scheme.tex", data: "JQ==" }],
  entry: "scheme.tex",
  packages: ["graphicx", "tikz", "chemnum"],
};
const html = (value: string) => `<meta charset="utf-8"><div data-editable-figure="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">\\import{figures/}{scheme.tex}</div>`;
const figure: ImportedFigure = { directory: "figures", entry: "scheme.tex", source: "figures/scheme.reactio", packages: ["graphicx", "tikz", "chemnum"] };

describe("editable figure manifest", () => {
  it("reads the manifest from the clipboard's HTML", () => {
    expect(editableFigureFromHtml(html(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it.each([
    ["plain HTML", "<p>text</p>"],
    ["broken JSON", html("{version: 1")],
    ["a newer version", html(JSON.stringify({ ...manifest, version: 2 }))],
    ["no outputs", html(JSON.stringify({ ...manifest, outputs: [] }))],
    ["a file without contents", html(JSON.stringify({ ...manifest, source: { name: "scheme.reactio" } }))],
  ])("ignores %s", (_name, value) => {
    expect(editableFigureFromHtml(value)).toBeNull();
  });
});

describe("forward compatibility of the manifest", () => {
  it("ignores optional fields it does not know", () => {
    const later = { ...manifest, somethingNew: { a: 1 } };
    expect(editableFigureFromHtml(html(JSON.stringify(later)))).toMatchObject({ entry: manifest.entry });
  });
});

describe("editable figure insertion", () => {
  const PATH = "\\graphicspath{{figures/}}";

  it("includes the entry from the project root, without its extension", () => {
    expect(editableFigureInclude(figure)).toBe("\\input{figures/scheme}");
    expect(editableFigureInclude({ directory: "", entry: "a.tex" })).toBe("\\input{a}");
  });

  it("adds only the packages the preamble lacks and the figure folder, after its last package line", () => {
    const source = "\\documentclass{article}\n\\usepackage[final]{graphicx,xcolor} % figures\n% \\usepackage{tikz}\n\\begin{document}\nText\n\\end{document}\n";
    expect(missingPreambleInsertions(source, figure.packages, "figures/")).toEqual([
      { from: source.indexOf("\n% \\usepackage{tikz}"), insert: `\n\\usepackage{tikz}\n\\usepackage{chemnum}\n${PATH}` },
    ]);
    const loaded = `\\documentclass{article}\n\\usepackage{graphicx,tikz}\n\\usepackage{chemnum}\n${PATH}\n\\begin{document}\n\\end{document}`;
    expect(missingPreambleInsertions(loaded, figure.packages, "figures/")).toEqual([]);
  });

  it("puts new lines before \\begin{document} when the preamble loads no package", () => {
    const source = "\\documentclass{article}\n\\begin{document}\n";
    expect(missingPreambleInsertions(source, ["tikz"], "figures/")).toEqual([
      { from: source.indexOf("\\begin"), insert: `\\usepackage{graphicx}\n\\usepackage{tikz}\n${PATH}\n` },
    ]);
  });

  it("adds the folder to an existing \\graphicspath, unless it is listed, ignoring comments", () => {
    const pre = "\\documentclass{a}\n\\usepackage{graphicx}\n";
    const other = `${pre}\\graphicspath{{img/}{a{b}/}}\n\\begin{document}\n`;
    expect(missingPreambleInsertions(other, [], "figures/")).toEqual([{ from: other.indexOf("}\n\\begin"), insert: "{figures/}" }]);
    expect(missingPreambleInsertions(`${pre}\\graphicspath{{img/}{figures/}}\n\\begin{document}\n`, [], "figures/")).toEqual([]);
    const commented = `${pre}% \\graphicspath{{figures/}}\n\\begin{document}\n`;
    expect(missingPreambleInsertions(commented, [], "figures/")).toEqual([
      { from: pre.length - 1, insert: `\n${PATH}` },
    ]);
  });

  it("takes ./figures/ as figures/, and counts what the preamble's files load and set", () => {
    const pre = "\\documentclass{a}\n\\usepackage{graphicx}\n";
    expect(missingPreambleInsertions(`${pre}\\graphicspath{{./figures/}}\n\\begin{document}\n`, [], "figures/")).toEqual([]);
    const bare = "\\documentclass{a}\n\\input{preamble}\n\\begin{document}\n";
    const known = "\\usepackage{graphicx}\n\\RequirePackage{tikz}\n\\graphicspath{{img/}}\n";
    expect(missingPreambleInsertions(bare, ["tikz"], "figures/", known)).toEqual([]);
    expect(knownGraphicsPath(known, "figures/")).toBe("unlisted");
    expect(knownGraphicsPath(`${known}\\graphicspath{{img/}{figures/}}`, "figures/")).toBe("listed");
    expect(knownGraphicsPath("% \\graphicspath{{img/}}", "figures/")).toBeNull();
  });

  it("needs no path for a figure in the project root", () => {
    expect(missingPreambleInsertions("\\usepackage{tikz}\n\\begin{document}\n", ["tikz"], "")).toEqual([]);
  });

  it("puts the include line at the selection and the preamble lines in one edit", () => {
    const source = "\\documentclass{article}\n\\begin{document}\nSee X.\n\\end{document}\n";
    const at = source.indexOf("X");
    const { changes, unplaced } = editableFigureChanges(source, { from: at, to: at + 1 }, figure);
    const next = EditorState.create({ doc: source }).update({ changes }).state.doc.toString();
    expect(next).toBe(
      `\\documentclass{article}\n\\usepackage{graphicx}\n\\usepackage{tikz}\n\\usepackage{chemnum}\n${PATH}\n\\begin{document}\nSee \\input{figures/scheme}.\n\\end{document}\n`,
    );
    expect(unplaced).toEqual([]);
  });

  it("names the lines to add by hand in a file that is not the root document", () => {
    const { changes, unplaced } = editableFigureChanges("\\section{Results}\n", { from: 0, to: 0 }, figure);
    expect(changes).toHaveLength(1);
    expect(unplaced).toEqual(["\\usepackage{graphicx}", "\\usepackage{tikz}", "\\usepackage{chemnum}", PATH]);
  });
});

describe("a manifest's preamble lines", () => {
  it("are definitions when nothing runs at the top level", () => {
    expect(isDefinitionsOnly(["\\providecommand\\a[1]{\\textbf{#1}}", "\\newcommand{\\b}{x} % note", "\\definecolor{c}{rgb}{1,0,0}"])).toBe(true);
    expect(isDefinitionsOnly(["\\makeatletter", "\\providecommand\\x@y[3]{}", "\\makeatother"])).toBe(true);
    expect(isDefinitionsOnly(["\\ExplSyntaxOn", "\\providecommand \\rcmpd [1]", "  { \\seq_item:Nn \\l_tmpa_seq { 2 } }", "\\ExplSyntaxOff"])).toBe(true);
    expect(isDefinitionsOnly([String.raw`\NewDocumentCommand{\c}{m}{#1}`, String.raw`\DeclareMathOperator*{\argmax}{arg\,max}`, String.raw`\newcounter{step}`])).toBe(true);
    expect(isDefinitionsOnly([String.raw`\usepackage{tikz}`, String.raw`\usepackage{chemnum, mhchem}`])).toBe(true);
  });

  it("are not when a group outside a definition would run", () => {
    // A group of its own, or one past a definition's last argument, runs as the preamble is read.
    expect(isDefinitionsOnly([String.raw`\newcommand\zz{}`, String.raw`{\input{/etc/passwd}}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\newcommand\a{x}{\input{/etc/passwd}}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\newcommand{\a\input{/etc/passwd}}{x}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\definecolor{c}{rgb}{\input{/etc/passwd}}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\usepackage{\input{/etc/passwd}}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\usepackage[shell]{a}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\newcounter{c}[section]`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\newcommand\a`])).toBe(false);
    expect(isDefinitionsOnly(["}", "\\newcommand\\a{x}"])).toBe(false);
  });

  it("are not when TeX reads a name differently, or a command could be replaced", () => {
    // Outside \makeatletter, `\a@{…}` is `\a`, then `@`, and the group runs.
    expect(isDefinitionsOnly([String.raw`\newcommand\foo@{\typeout{ran}}`])).toBe(false);
    expect(isDefinitionsOnly([String.raw`\newcommand{\foo@}{x}`])).toBe(false);
    expect(isDefinitionsOnly(["\\makeatletter", String.raw`\newcommand\foo@{x}`, "\\makeatother", String.raw`\newcommand\bar@{x}`])).toBe(false);
    expect(isDefinitionsOnly(["\\makeatletter", String.raw`\newcommand{\foo@}{x}`, "\\makeatother"])).toBe(true);
    // \DeclareRobustCommand silently replaces a command the document has.
    expect(isDefinitionsOnly([String.raw`\DeclareRobustCommand\maketitle{}`])).toBe(false);
  });

  it("are not when anything else is there", () => {
    expect(isDefinitionsOnly(["\\input{/etc/passwd}"])).toBe(false);
    expect(isDefinitionsOnly(["\\newcommand\\a{x}\\a"])).toBe(false);
    expect(isDefinitionsOnly(["\\renewcommand\\section{x}"])).toBe(false);
    expect(isDefinitionsOnly(["text"])).toBe(false);
    expect(isDefinitionsOnly(["\\newcommand\\a{"])).toBe(false);
  });
});

describe("figure source path", () => {
  it("resolves the first line's source against the entry file", () => {
    expect(figureSourcePath("figures/a.tex", "% editable-figure source: Document 1.reactio\n\\begin{tikzpicture}")).toBe("figures/Document 1.reactio");
    expect(figureSourcePath("a.tex", "% editable-figure source: art/a.reactio\r\n")).toBe("art/a.reactio");
    expect(figureSourcePath("figures/a.tex", "% editable-figure source: ../art/a.reactio")).toBe("art/a.reactio");
  });

  it("is null for other files and for paths outside the project", () => {
    expect(figureSourcePath("main.tex", "\\documentclass{article}")).toBeNull();
    expect(figureSourcePath("main.tex", "\n% editable-figure source: a.reactio")).toBeNull();
    expect(figureSourcePath("figures/a.tex", "% editable-figure source: ../../a.reactio")).toBeNull();
    expect(figureSourcePath("figures/a.tex", "% editable-figure source: /etc/a.reactio")).toBeNull();
    expect(figureSourcePath("figures/a.tex", "% editable-figure source: C:/a.reactio")).toBeNull();
  });

  it("reads a long first line at once rather than backtracking over it", () => {
    // A line of spaces cost a pattern four times as much for twice its
    // length, so any .tex the watcher reported could hold the window.
    const padded = `% editable-figure source: a.svg${" ".repeat(400_000)}x`;
    const started = performance.now();
    expect(figureSourcePath("figures/a.tex", padded)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    expect(figureSourcePath("figures/a.tex", `% editable-figure source: a.svg${" ".repeat(20)}`)).toBe("figures/a.svg");
  });
});

describe("included files on a source line", () => {
  it("reads each include form, from the root and from the including file", () => {
    expect(includedTexPaths(String.raw`\import{figures/}{a.tex}`, "main.tex")).toEqual(["figures/a.tex"]);
    expect(includedTexPaths(String.raw`\input{figures/a}`, "ch/one.tex")).toEqual(["figures/a.tex", "ch/figures/a.tex"]);
    expect(includedTexPaths(String.raw`\subimport{./f}{a}\include{b.tex}`, "main.tex")).toEqual(["f/a.tex", "b.tex"]);
  });

  it("ignores comments and other lines", () => {
    expect(includedTexPaths(String.raw`% \input{a}`, "main.tex")).toEqual([]);
    expect(includedTexPaths("plain text", "main.tex")).toEqual([]);
  });
});

describe("definitions a figure needs in the preamble", () => {
  const block = ["% note", "\\providecommand\\cmpdseries[2]{#1}"];
  const doc = "\\documentclass{a}\n\\begin{document}\nX\n\\end{document}\n";
  const figureWith = { ...figure, packages: [], preamble: block };
  const at = { from: doc.indexOf("X"), to: doc.indexOf("X") };

  it("adds the block once, before \\begin{document}", () => {
    const { changes } = editableFigureChanges(doc, at, figureWith);
    const next = EditorState.create({ doc }).update({ changes }).state.doc.toString();
    expect(next.indexOf("\\providecommand\\cmpdseries")).toBeLessThan(next.indexOf("\\begin{document}"));
    const again = editableFigureChanges(next, { from: next.indexOf("X"), to: next.indexOf("X") }, figureWith).changes;
    const twice = EditorState.create({ doc: next }).update({ changes: again }).state.doc.toString();
    expect(twice.split("cmpdseries[2]")).toHaveLength(2);
  });

  it("adds nothing for a figure that sends no preamble", () => {
    const { changes } = editableFigureChanges(doc, at, { ...figure, packages: [] });
    expect(JSON.stringify(changes)).not.toContain("cmpdseries");
  });

  it("leaves it out when the document or a file it loads defines the command, not when that is commented", () => {
    const has = (text: string, known = "") => editableFigureChanges(text, at, figureWith, known).changes.some((change) => JSON.stringify(change).includes("cmpdseries[2]"));
    expect(has(doc, "\\newcommand{\\cmpdseries}[2]{}")).toBe(false);
    expect(has(doc, "% \\newcommand{\\cmpdseries}[2]{}")).toBe(true);
  });

  it("is shown first when it would run more than definitions", () => {
    expect(preambleNeedsConfirmation(doc, "", figureWith)).toBe(false);
    const smuggled = { ...figureWith, preamble: [...block, String.raw`{\input{/etc/passwd}}`] };
    expect(preambleNeedsConfirmation(doc, "", smuggled)).toBe(true);
  });

  it("names it for a file that is not the root document, and finds the preamble's own files", () => {
    expect(editableFigureChanges("\\section{x}\n", { from: 0, to: 0 }, figureWith).unplaced).toEqual(expect.arrayContaining(block));
    expect(preambleFiles("\\usepackage{a,b}\n\\input{macros}\n\\begin{document}\n\\input{ch}\n")).toEqual(["macros.tex", "a.sty", "b.sty"]);
  });
});

describe("a figure pasted as a float of its own", () => {
  const body = (text: string) => `\\documentclass{a}\n\\begin{document}\n${text}\n\\end{document}\n`;
  const at = (source: string, mark: string) => ({ from: source.indexOf(mark), to: source.indexOf(mark) });

  it("knows the environments that already hold a figure, closed or commented ones aside", () => {
    const inside = body("\\begin{scheme*}\nHERE\n\\end{scheme*}");
    expect(insideFigureHolder(inside, inside.indexOf("HERE"))).toBe(true);
    const tocentry = body("\\begin{tocentry}\nHERE\n\\end{tocentry}");
    expect(insideFigureHolder(tocentry, tocentry.indexOf("HERE"))).toBe(true);
    const closed = body("\\begin{figure}\\end{figure}\nHERE");
    expect(insideFigureHolder(closed, closed.indexOf("HERE"))).toBe(false);
    const commented = body("% \\begin{figure}\nHERE");
    expect(insideFigureHolder(commented, commented.indexOf("HERE"))).toBe(false);
  });

  it("takes an empty line of the body, not a line of text, the preamble or an existing float", () => {
    const empty = body("Text.\n\n\nMore.");
    const line = empty.indexOf("\n\n") + 1;
    expect(pastesFigureBlock(empty, { from: line, to: line })).toBe(true);
    const text = body("See X now.");
    expect(pastesFigureBlock(text, at(text, "X"))).toBe(false);
    const preamble = "\\documentclass{a}\n\n\\begin{document}\n";
    expect(pastesFigureBlock(preamble, { from: 18, to: 18 })).toBe(false);
    const float = body("\\begin{figure}\n\n\\end{figure}");
    const inFloat = float.indexOf("\n\n") + 1;
    expect(pastesFigureBlock(float, { from: inFloat, to: inFloat })).toBe(false);
  });

  it("takes an empty line of a file that is not the root document", () => {
    expect(pastesFigureBlock("\n", { from: 0, to: 0 })).toBe(true);
  });

  it("fills in the float with the cursor in the caption, then the label", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "" }), parent: document.body });
    snippet(editableFigureBlockSnippet(figure))(view, null, 0, 0);
    const text = view.state.doc.toString();
    expect(text).toBe("\\begin{figure}\n  \\centering\n  \\input{figures/scheme}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}");
    expect(view.state.selection.main.head).toBe(text.indexOf("\\caption{") + "\\caption{".length);
    nextSnippetField(view);
    expect(view.state.selection.main.head).toBe(text.indexOf("fig:") + "fig:".length);
    view.destroy();
  });
});
