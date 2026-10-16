import { describe, expect, it } from "vitest";
import { changedWords, joinedPassage, prosePassages, sectionAt } from "./version-prose";

describe("changedWords", () => {
  it("counts the prose words edits add and remove, each CJK character as one and other letters by the run", () => {
    const passages = prosePassages(
      "Attention maps explain predictions. 注意力图解释预测。\n",
      "Attention maps describe routing weights. 注意力图描述权重。\n",
    )!;
    expect(changedWords(passages)).toEqual({ added: 3 + 4, removed: 2 + 4 });
    // Only the CJK characters that differ count, though the diff replaces the whole run.
    expect(changedWords(prosePassages("我们提出了一种新的方法。\n", "我们提出了一种更好的方法。\n")!)).toEqual({ added: 2, removed: 1 });
    const added = prosePassages("Intro.\n", "Intro.\n\nnaïve Gödel’s Ελληνικά слово かな 한글\n")!;
    expect(changedWords(added)).toEqual({ added: 4 + 2 + 2, removed: 0 });
    // Prose only: not commands, citation and reference keys, or comments.
    const cited = prosePassages(
      "Attention helps.\n",
      "Attention helps~\\cite{vaswani2017attention} (see \\eqref{eq:attn}), \\emph{a lot}. % TODO cut\n",
    )!;
    expect(changedWords(cited)).toEqual({ added: 3, removed: 0 });
    const rekeyed = prosePassages("As shown~\\cite{bahdanau2015neural}.\n", "As shown~\\cite{luong2015effective}.\n")!;
    expect(changedWords(rekeyed)).toEqual({ added: 0, removed: 0 });
    const figure = prosePassages(
      "Results.\n",
      "Results.\n\\begin{figure}[t]\n\\includegraphics[width=0.5\\linewidth]{figures/attn.pdf}\n\\caption{Attention maps.}\n\\end{figure}\n\\begin{tabular}{lcc} x \\end{tabular}\n\\input{sections/intro}\n",
    )!;
    expect(changedWords(figure)).toEqual({ added: 3, removed: 0 });
  });
});

describe("sectionAt", () => {
  const source = [
    "\\section{Introduction}", // 1
    "Text.", // 2
    "\\subsection[Short]{Fast \\emph{exact} attention}", // 3
    "% \\section{Commented out}", // 4
    "Text.", // 5
    "\\section*{Acknowledgements}", // 6
    "Thanks.", // 7
    "\\section{Method}", // 8
    "Text.", // 9
  ].join("\n");

  it("names a line's section as LaTeX numbers it", () => {
    expect(sectionAt(source, 2)).toBe("§1 Introduction");
    expect(sectionAt(source, 5)).toBe("§1.1 Fast exact attention");
    expect(sectionAt(source, 7)).toBe("Acknowledgements");
    expect(sectionAt(source, 9)).toBe("§2 Method");
    expect(sectionAt("Preamble text.\n\\section{Later}\n", 1)).toBeNull();
  });
});

describe("joinedPassage", () => {
  it("joins edits that only a space or a short shared word keep apart", () => {
    const [passage] = prosePassages(
      "A decoder could look at encoder states of a source sentence.\n",
      "A decoder could retrieve different encoder states of an entire source sentence.\n",
    )!;
    const joined = joinedPassage(passage!);
    const read = (edit: { from: number; to: number; insert: string }) => [passage!.text.slice(edit.from, edit.to), edit.insert];
    expect(joined.edits.map(read)).toEqual([["look at", "retrieve different"], ["a", "an entire"]]);
    expect(joined.edits.map((edit) => edit.id)).toEqual([0, 1]);
  });
});
