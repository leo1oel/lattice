import { describe, expect, it } from "vitest";
import { changedRuns, splitLines, type ChangedRun } from "./changed-runs";
import { applyOps, diffToOps } from "./ot";

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** `b` rebuilt from `a` and the runs: unchanged lines between runs must match exactly. */
function rebuild(a: string[], b: string[], runs: ChangedRun[]): string[] {
  const out: string[] = [];
  let x = 0;
  let y = 0;
  for (const run of runs) {
    expect(run.aFrom - x).toBe(run.bFrom - y);
    for (; x < run.aFrom; x += 1, y += 1) {
      expect(a[x]).toBe(b[y]);
      out.push(a[x]!);
    }
    out.push(...b.slice(run.bFrom, run.bTo));
    x = run.aTo;
    y = run.bTo;
  }
  expect(a.length - x).toBe(b.length - y);
  out.push(...a.slice(x));
  return out;
}

describe("changedRuns", () => {
  it("splits lines keeping their breaks", () => {
    expect(splitLines("a\nb\n\nc")).toEqual(["a\n", "b\n", "\n", "c"]);
    expect(splitLines("")).toEqual([]);
  });

  it("finds each changed run on its own, with the unchanged lines between them matched", () => {
    const a = ["one\n", "two\n", "three\n", "four\n", "five\n"];
    const b = ["ONE\n", "two\n", "three\n", "4\n", "4b\n", "five\n"];
    expect(changedRuns(a, b, 10)).toEqual([
      { aFrom: 0, aTo: 1, bFrom: 0, bTo: 1 },
      { aFrom: 3, aTo: 4, bFrom: 3, bTo: 5 },
    ]);
    expect(changedRuns(a, a, 10)).toEqual([]);
    expect(changedRuns([], b, 10)).toEqual([{ aFrom: 0, aTo: 0, bFrom: 0, bTo: 6 }]);
  });

  it("gives up past the limit rather than matching at any cost", () => {
    const a = Array.from({ length: 50 }, (_, index) => `${index}\n`);
    const b = a.map((line) => `x${line}`);
    expect(changedRuns(a, b, 20)).toBeNull();
  });

  it("always describes a real edit, on random line lists", () => {
    const next = random(7);
    const words = ["a\n", "b\n", "c\n", "d\n"];
    for (let round = 0; round < 500; round += 1) {
      const a = Array.from({ length: Math.floor(next() * 12) }, () => words[Math.floor(next() * words.length)]!);
      const b = Array.from({ length: Math.floor(next() * 12) }, () => words[Math.floor(next() * words.length)]!);
      const runs = changedRuns(a, b, 100)!;
      expect(rebuild(a, b, runs)).toEqual(b);
    }
  });
});

describe("diffToOps across lines", () => {
  it("keeps changes made far apart as separate ops, not one rewrite of everything between", () => {
    const before = "\\section{Intro}\nWe use foo here.\nMiddle paragraph.\nAnd foo again.\n";
    const after = "\\section{Intro}\nWe use bar here.\nMiddle paragraph.\nAnd bar again.\n";
    const ops = diffToOps(before, after);
    expect(ops).toEqual([{ p: 23, d: "foo" }, { p: 23, i: "bar" }, { p: 55, d: "foo" }, { p: 55, i: "bar" }]);
    expect(applyOps(before, ops)).toBe(after);
  });

  it("still sends one op for one contiguous change, even across lines", () => {
    expect(diffToOps("a\nb\nc", "a\nB\nC\nc")).toEqual([{ p: 2, d: "b" }, { p: 2, i: "B\nC" }]);
  });

  it("always reproduces the new text, on random documents", () => {
    const next = random(11);
    const pieces = ["x", "y", "\n", "é", "😀"];
    const text = () => Array.from({ length: Math.floor(next() * 30) }, () => pieces[Math.floor(next() * pieces.length)]).join("");
    for (let round = 0; round < 500; round += 1) {
      const [before, after] = [text(), text()];
      expect(applyOps(before, diffToOps(before, after))).toBe(after);
    }
  });
});
