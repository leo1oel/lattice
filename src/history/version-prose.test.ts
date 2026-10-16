import { describe, expect, it } from "vitest";
import { changedWords, joinedPassage, prosePassages, sectionAt } from "./version-prose";

describe("changedWords", () => {
  // The diff takes a run of CJK characters as one token, so a changed run counts whole.
  it("counts the words edits add and remove, each CJK character as one", () => {
    const passages = prosePassages(
      "Attention maps explain predictions. 注意力图解释预测。\n",
      "Attention maps describe routing weights. 注意力图描述权重。\n",
    )!;
    expect(changedWords(passages)).toEqual({ added: 3 + 8, removed: 2 + 8 });
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
