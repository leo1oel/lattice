import { describe, expect, it, vi } from "vitest";
import { compiledLabels, parseAux } from "./compiled-labels";
import { equationHtml } from "./equation-card";
import { katexSource } from "./math-region";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("compiled label numbers", () => {
  it("reads each label's number and page, with or without hyperref, and skips cleveref's twins", () => {
    const { labels, inputs } = parseAux([
      "\\relax",
      "\\newlabel{eq:loss}{{3}{4}{Training}{equation.2.3}{}}",
      "\\newlabel{eq:loss@cref}{{[equation][3][]3}{[1][4][]4}}",
      "\\newlabel{sec:intro}{{1.2}{\\relax 2}}",
      "\\newlabel{fig:{nested}}{{\\textup {5}}{7}}",
      "\\@input{chapters/results.aux}",
    ].join("\n"));
    expect(Object.fromEntries(labels)).toEqual({
      "eq:loss": { number: "3", page: "4" },
      "sec:intro": { number: "1.2", page: "2" },
    });
    expect(inputs).toEqual(["chapters/results.aux"]);
  });

  it("reads the root document's .aux and its chapters' once per build", async () => {
    const files: Record<string, string> = {
      "paper/main.aux": "\\newlabel{eq:a}{{1}{2}}\n\\@input{chapters/b.aux}\n",
      "paper/chapters/b.aux": "\\newlabel{eq:b}{{2.1}{9}}\n",
    };
    invoke.mockImplementation((_command: string, { path }: { path: string }) =>
      path in files ? Promise.resolve(files[path]) : Promise.reject(new Error("missing")));
    const build = { rootDocument: "paper/main.tex" };
    const labels = await compiledLabels("/p", build);
    expect(Object.fromEntries(labels)).toEqual({ "eq:a": { number: "1", page: "2" }, "eq:b": { number: "2.1", page: "9" } });
    await compiledLabels("/p", build);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect((await compiledLabels("/p", { rootDocument: "other.tex" })).size).toBe(0);
  });
});

describe("equation math for KaTeX", () => {
  it("drops bookkeeping and sets top-level & columns as aligned", () => {
    expect(katexSource("a = b \\label{eq:a} \\nonumber")).toBe("a = b");
    expect(katexSource("a &= b \\\\ c &= d")).toBe("\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}");
    expect(katexSource("f = \\begin{cases} 1 & x \\\\ 0 & y \\end{cases}")).toBe("f = \\begin{cases} 1 & x \\\\ 0 & y \\end{cases}");
  });

  it("renders an equation with the project's macros, and nothing for math KaTeX cannot set", () => {
    expect(equationHtml("\\R^n \\label{eq:a}", { "\\R": "\\mathbb{R}" })).toContain("katex-display");
    expect(equationHtml("x &= \\frac{1}{2} \\\\ y &= 2")).toContain("katex-display");
    expect(equationHtml("\\frac{1}{")).toBeNull();
  });
});
