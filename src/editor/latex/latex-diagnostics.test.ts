import { describe, expect, it } from "vitest";
import { indexDiagnostics, pathDiagnostics, structureDiagnostics } from "./latex-diagnostics";
import { uncommented } from "./latex-language";
import { parseGraphicsPaths, type ReferenceInfo } from "./latex-text";

const figure = (label: string, path = "main.tex"): ReferenceInfo =>
  ({ label, kind: "figure", title: "", snippet: "", path, line: 1 });
const messages = (diagnostics: { message: string }[]) => diagnostics.map((item) => item.message);

describe("LaTeX diagnostics", () => {
  it("flags unmatched environments and duplicate labels", () => {
    expect(messages(structureDiagnostics(
      "\\begin{figure}\n\\label{fig:a}\n\\label{fig:a}\n\\end{table}\n\\begin{equation}\n",
    ))).toEqual([
      "Expected \\end{figure}, found \\end{table}.",
      "Unclosed \\begin{equation}.",
      "Duplicate label “fig:a”.",
    ]);
  });

  // Folding and auto-close read comments through `uncommented`; lint must
  // agree with them, or it reports an environment the comment hides.
  it.each([
    ["an escaped percent is text", String.raw`50\% \begin{equation}`, true],
    ["a line break before a percent leaves a comment", String.raw`\\%\begin{equation}`, false],
    ["three backslashes escape the percent", String.raw`\\\%\begin{equation}`, true],
    ["four backslashes leave a comment", String.raw`\\\\% \begin{equation}`, false],
    ["a percent inside inline math is a comment", "$x % \\begin{equation}\n$", false],
  ])("%s", (_name, source, unclosed) => {
    expect(messages(structureDiagnostics(source))).toEqual(unclosed ? ["Unclosed \\begin{equation}."] : []);
    expect(uncommented(source.split("\n")[0]).includes("\\begin{equation}")).toBe(unclosed);
  });

  it("keeps offsets after a comment", () => {
    const source = "% \\end{x}\n$a$ % note\n\\begin{equation}";
    expect(structureDiagnostics(source).map(({ from, to }) => [from, to]))
      .toEqual([[source.indexOf("\\begin"), source.length]]);
  });

  it.each([
    ["unclosed math delimiters", "Hello $x + y and $$a", ["Unclosed display math $$", "Unclosed inline math $"]],
    ["duplicate bibliography keys", "@article{same,\n  title={A},\n}\n@misc{same,\n  title={B},\n}\n", ["Duplicate bibliography key “same”"]],
  ])("flags %s", (_name, source, expected) => {
    const found = messages(structureDiagnostics(source));
    for (const message of expected) expect(found.some((item) => item.includes(message))).toBe(true);
  });

  it("warns about unknown, unused, and cross-file duplicate labels and citation keys", () => {
    expect(messages(indexDiagnostics(
      "See \\citep{missing} and \\ref{fig:gone}.",
      { citationKeys: ["known"], references: [{ ...figure("fig:model"), title: "Model" }] },
    ))).toEqual(["Unknown citation key “missing”.", "Unknown label “fig:gone”."]);
    expect(messages(indexDiagnostics(
      "\\label{fig:dead} @article{dead, title={X},}",
      { citationKeys: ["dead"], references: [figure("fig:dead")], unusedLabels: ["fig:dead"], unusedCitations: ["dead"] },
      "main.tex",
    ))).toEqual(["Unused label “fig:dead”.", "Unused citation key “dead”."]);
    const diagnostics = indexDiagnostics(
      "\\label{fig:shared}",
      { citationKeys: [], references: [figure("fig:shared"), { ...figure("fig:shared", "sections/a.tex"), line: 3 }] },
      "main.tex",
    );
    expect(messages(diagnostics).some((message) => message.includes("also defined in sections/a.tex"))).toBe(true);
  });

  it("reports no label or citation diagnostics until the project's index has landed", () => {
    expect(messages(indexDiagnostics(
      "\\label{fig:shared} \\citep{missing} \\ref{fig:gone} \\input{gone} $x",
      { citationKeys: [], references: [figure("fig:shared", "sections/a.tex")], projectPaths: ["main.tex"], indexPending: true },
      "main.tex",
    ))).toEqual(["Unclosed inline math $.", "Missing file “gone”."]);
  });

  it("flags missing include and graphics paths and offers to create a missing file", () => {
    const created: string[] = [];
    const diagnostics = pathDiagnostics(
      "\\input{missing}\n\\includegraphics{figures/gone.pdf}\n\\input{sections/ok}",
      ["sections/ok.tex", "figures/kept.pdf"],
      [],
      (path) => created.push(path),
    );
    expect(messages(diagnostics)).toEqual(["Missing file “missing”.", "Missing figure “figures/gone.pdf”."]);
    diagnostics[0]?.actions?.[0]?.apply(null as never, 0, 0);
    expect(created).toEqual(["missing.tex"]);
  });

  it("resolves figures wrapped in detokenize or found through graphicspath", () => {
    expect(pathDiagnostics(
      "\\includegraphics[width=\\linewidth]{\\detokenize{figures/native-umm-converted.pdf}}",
      ["figures/native-umm-converted.pdf"],
    )).toEqual([]);
    const roots = parseGraphicsPaths(["\\graphicspath{{figs/}{images/}}\n"]);
    expect(roots).toEqual(["figs", "images"]);
    expect(pathDiagnostics("\\includegraphics{plot}", ["figs/plot.pdf", "images/other.png"], roots)).toEqual([]);
    expect(messages(pathDiagnostics("\\includegraphics{missing}", ["figs/plot.pdf"], roots)))
      .toEqual(["Missing figure “missing”."]);
  });
});
