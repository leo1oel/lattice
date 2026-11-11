import { describe, expect, it, vi } from "vitest";
import {
  bibliographyEntryLine,
  katexMacrosFromSources,
  mergeReferences,
  parseLocalLabels,
  parseLocalMacros,
  resolveTexPath,
  type ReferenceInfo,
} from "./latex-text";
import { equationHtml } from "./equation-card";

describe("LaTeX source parsing", () => {
  it("preserves lines and snippets across duplicate, empty, and multiline labels", () => {
    const source = "  \\label{first} \\label{second}  \r\n\n😀 \\label{first}\n\\label{ }\n  \\label{\n last\n} tail";
    expect(parseLocalLabels("body.tex", source)).toEqual([
      { label: "first", kind: "reference", title: "first", path: "body.tex", line: 1, snippet: "\\label{first} \\label{second}" },
      { label: "second", kind: "reference", title: "second", path: "body.tex", line: 1, snippet: "\\label{first} \\label{second}" },
      { label: "last", kind: "reference", title: "last", path: "body.tex", line: 5, snippet: "\\label{" },
    ]);
  });

  it("does not split the whole live buffer once per label", () => {
    const source = Array.from({ length: 100 }, (_, i) => `prose\n\\label{eq:${i}}\n`).join("");
    const split = vi.spyOn(String.prototype, "split");
    let fullBufferSplits: number;
    try {
      const labels = parseLocalLabels("main.tex", source);
      fullBufferSplits = split.mock.contexts.filter((value) => String(value) === source).length;
      expect(labels).toHaveLength(100);
      expect(labels[99]).toMatchObject({ label: "eq:99", line: 200, snippet: "\\label{eq:99}" });
    } finally {
      split.mockRestore();
    }
    expect(fullBufferSplits).toBeLessThanOrEqual(1);
  });

  it("merges live labels from the dirty buffer, keeping figure preview metadata", () => {
    const other: ReferenceInfo = { label: "fig:old", kind: "figure", title: "", snippet: "", path: "other.tex", line: 1 };
    expect(mergeReferences([other], "main.tex", parseLocalLabels("main.tex", "\\label{fig:new}"))
      .map((item) => item.label).sort()).toEqual(["fig:new", "fig:old"]);
    const figure: ReferenceInfo = {
      label: "fig:native-umm", kind: "figure", title: "Native UMM", path: "main.tex", line: 12,
      snippet: "\\includegraphics{figures/native-umm.pdf}", imagePath: "figures/native-umm.pdf",
    };
    const merged = mergeReferences([figure], "main.tex", parseLocalLabels("main.tex", "\\label{fig:native-umm}"));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ imagePath: "figures/native-umm.pdf", kind: "figure", title: "Native UMM" });
  });

  it("parses project macros for completion", () => {
    const macros = parseLocalMacros(["\\newcommand{\\loss}{L}\n\\newenvironment{proofbox}{}{}\n"]);
    expect(macros.map((item) => item.label)).toEqual(["\\loss", "\\begin{proofbox}"]);
  });

  it("finds bibliography entry lines by key", () => {
    const bib = "@article{first,\n  title={A},\n}\n@inproceedings{second,\n  title={B},\n}\n";
    expect(bibliographyEntryLine(bib, "second")).toBe(4);
    expect(bibliographyEntryLine(bib, "missing")).toBeNull();
  });

  it("resolves an include argument to a project .tex file", () => {
    const paths = ["main.tex", "sections/method.tex"];
    expect(resolveTexPath("sections/method", paths)).toBe("sections/method.tex");
    expect(resolveTexPath(" method ", paths)).toBe("sections/method.tex");
    expect(resolveTexPath("missing", paths)).toBeNull();
  });

  describe("katexMacrosFromSources", () => {
    it("collects newcommand macros for KaTeX, keeping the first definition", () => {
      expect(katexMacrosFromSources([
        String.raw`\newcommand{\R}{\mathbb{R}}`,
        String.raw`\renewcommand{\eps}{\varepsilon}`,
        String.raw`\newcommand{\R}{second}`,
      ])).toEqual({ "\\R": String.raw`\mathbb{R}`, "\\eps": String.raw`\varepsilon` });
    });

    it("reads bodies that nest braces more than one level deep", () => {
      expect(katexMacrosFromSources([String.raw`
        \newcommand{\bmu}{{\boldsymbol{\mu}}}
        \newcommand{\dmodel}{d_{\text{model}}}
      `])).toEqual({ "\\bmu": String.raw`{\boldsymbol{\mu}}`, "\\dmodel": String.raw`d_{\text{model}}` });
    });

    it("reads renew/provide/robust forms, a starred form, bare names and arities", () => {
      expect(katexMacrosFromSources([String.raw`
        \providecommand{\half}{\frac12}
        \DeclareRobustCommand{\vect}[1]{\mathbf{#1}}
        \newcommand*\mc[1]{\mathcal{#1}}
        \newcommand \pair [2] {\langle #1, #2\rangle}
        \newcommand\concat[3]{\left[#1 \parallel_#3 #2\right]}
      `])).toEqual({
        "\\half": String.raw`\frac12`,
        "\\vect": String.raw`\mathbf{#1}`,
        "\\mc": String.raw`\mathcal{#1}`,
        "\\pair": String.raw`\langle #1, #2\rangle`,
        "\\concat": String.raw`\left[#1 \parallel_#3 #2\right]`,
      });
    });

    it("gives a command with an optional argument its form without one", () => {
      expect(katexMacrosFromSources([String.raw`
        \newcommand{\norm}[2][2]{\|#2\|_{#1}}
        \newcommand{\at}[1][t]{x_{#1}}
      `])).toEqual({ "\\norm": String.raw`\|#1\|_{2}`, "\\at": "x_{t}" });
    });

    it("reads \\def and \\gdef with plain parameters and skips delimited ones", () => {
      expect(katexMacrosFromSources([String.raw`
        \def\RR{\mathbb{R}}
        \def \inner#1#2{\langle #1 , #2 \rangle}
        \gdef\tr{\operatorname{tr}}
        \def\dot#1.{#1}
      `])).toEqual({
        "\\RR": String.raw`\mathbb{R}`,
        "\\inner": String.raw`\langle #1 , #2 \rangle`,
        "\\tr": String.raw`\operatorname{tr}`,
      });
    });

    it("turns \\DeclareMathOperator and its starred form into \\operatorname", () => {
      expect(katexMacrosFromSources([String.raw`
        \DeclareMathOperator{\Tr}{Tr}
        \DeclareMathOperator*{\argmax}{arg\,max}
      `])).toEqual({ "\\Tr": String.raw`\operatorname{Tr}`, "\\argmax": String.raw`\operatorname*{arg\,max}` });
    });

    it("ignores definitions inside comments but not after an escaped percent", () => {
      expect(katexMacrosFromSources([String.raw`
        %\newcommand{\kq}{{q}_k}
        \newcommand{\kq}{q} % \newcommand{\km}{{m}_k}
        \newcommand{\pct}{5\%} \newcommand{\vq}{o}
        \\\newcommand{\vm}{m}
      `])).toEqual({ "\\kq": "q", "\\pct": String.raw`5\%`, "\\vq": "o", "\\vm": "m" });
    });

    it("skips an unclosed definition and definitions inside another's body", () => {
      expect(katexMacrosFromSources([
        String.raw`\newcommand{\outer}{\def\inner{x}y}`,
        String.raw`\newcommand{\open}{\mathbf{x`,
      ])).toEqual({ "\\outer": String.raw`\def\inner{x}y` });
    });

    // Preamble lines and formulas from DDPM (arXiv 2006.11239) and "Attention
    // Is All You Need" (arXiv 1706.03762) that KaTeX failed on with the old
    // one-level-brace regex.
    it("renders formulas from real papers that failed with the old regex", () => {
      const macros = katexMacrosFromSources([String.raw`
        \newcommand{\E}{\mathbb{E}}
        \newcommand{\Eb}[2]{\E_{#1}\!\left[#2\right]}
        \newcommand{\kl}[2]{D_{\mathrm{KL}}\!\left(#1 ~ \| ~ #2\right)}
        \newcommand{\bx}{\mathbf{x}}
        \newcommand{\bI}{\mathbf{I}}
        \newcommand{\bepsilon}{{\boldsymbol{\epsilon}}}
        \newcommand{\bmu}{{\boldsymbol{\mu}}}
        \newcommand{\bSigma}{{\boldsymbol{\Sigma}}}
        \newcommand{\dmodel}{d_{\text{model}}}
        \newcommand{\dff}{d_{\text{ff}}}
      `]);
      const formulas = [
        String.raw`p_\theta(\bx_{t-1}|\bx_t) = \mathcal{N}(\bx_{t-1}; \bmu_\theta(\bx_t, t), \bSigma_\theta(\bx_t, t))`,
        String.raw`\Eb{t, \bx_0, \bepsilon}{ \left\| \bepsilon - \bepsilon_\theta(\sqrt{\bar\alpha_t} \bx_0 + \sqrt{1-\bar\alpha_t}\bepsilon, t) \right\|^2}`,
        String.raw`\kl{q(\bx_T|\bx_0)}{p(\bx_T)}`,
        String.raw`\mathrm{FFN}(x) : \mathbb{R}^{\dmodel} \to \mathbb{R}^{\dff}`,
      ];
      for (const formula of formulas) expect(equationHtml(formula, macros), formula).not.toBeNull();
      expect(equationHtml(formulas[0], {})).toBeNull();
    });
  });

});
