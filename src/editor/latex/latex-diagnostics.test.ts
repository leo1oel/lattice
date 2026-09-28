import { describe, expect, it } from "vitest";
import { indexDiagnostics, pathDiagnostics, structureDiagnostics } from "./latex-diagnostics";
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

  it.each([
    ["unclosed math delimiters", "Hello $x + y and $$a", ["Unclosed display math $$", "Unclosed inline math $"]],
    ["duplicate bibliography keys", "@article{same,\n  title={A},\n}\n@misc{same,\n  title={B},\n}\n", ["Duplicate bibliography key “same”"]],
  ])("flags %s", (_name, source, expected) => {
    const found = messages(structureDiagnostics(source));
    for (const message of expected) expect(found.some((item) => item.includes(message))).toBe(true);
  });

  it("warns about unknown citation keys and labels", () => {
    expect(messages(indexDiagnostics(
      "See \\citep{missing} and \\ref{fig:gone}.",
      { citationKeys: ["known"], references: [{ ...figure("fig:model"), title: "Model" }] },
    ))).toEqual(["Unknown citation key “missing”.", "Unknown label “fig:gone”."]);
  });

  it("warns about unused labels and bibliography keys", () => {
    expect(messages(indexDiagnostics(
      "\\label{fig:dead} @article{dead, title={X},}",
      { citationKeys: ["dead"], references: [figure("fig:dead")], unusedLabels: ["fig:dead"], unusedCitations: ["dead"] },
      "main.tex",
    ))).toEqual(["Unused label “fig:dead”.", "Unused citation key “dead”."]);
  });

  it("warns when a label is also defined in another file", () => {
    const diagnostics = indexDiagnostics(
      "\\label{fig:shared}",
      { citationKeys: [], references: [figure("fig:shared"), { ...figure("fig:shared", "sections/a.tex"), line: 3 }] },
      "main.tex",
    );
    expect(messages(diagnostics).some((message) => message.includes("also defined in sections/a.tex"))).toBe(true);
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
