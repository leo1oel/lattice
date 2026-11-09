import { describe, expect, it } from "vitest";
import { compoundCommand, compoundMarksOnLine, isLoneSmallLetter, compoundEntries, compoundKeysIn, compoundKeysOnLine, looksLikeCompoundNumber, parseCompoundNumbers } from "./compound-keys";

const AUX = String.raw`\chemnum@cmpd {ketone}{1}{1}{}{}{}{}{\bfseries }
\chemnum@cmpd {alcohol}{2}{2}{}{}{}{}{\bfseries }
\chemnum@subcmpd {alcohol}{OMe}{1}{a}
\chemnum@cmpd {ten}{10}{10}{}{}{}{}{\bfseries }
\chemnum@check `;

describe("compound keys", () => {
  it.each(["1", "2a", "3.1", "4-2", "1.2.3a", "IV", "ii", "S5", "A", " 12 ", "(1)", "2a,"])("reads %j as a compound number", (text) => {
    expect(looksLikeCompoundNumber(text)).toBe(true);
  });

  it.each(["", "ketone", "85%", "1 gives", "2A", "Scheme"])("does not read %j as one", (text) => {
    expect(looksLikeCompoundNumber(text)).toBe(false);
  });

  it("finds the key of a figure's number line", () => {
    expect(compoundKeysOnLine(String.raw`    \node at (0.5,0.19) {\fontsize{10}{12}\selectfont \cmpd{alcohol.OMe}~(85\%)};`))
      .toEqual(["alcohol.OMe"]);
  });

  it("finds every key of a line, once each, across the command's forms", () => {
    expect(compoundKeysOnLine(String.raw`\cmpd{a, b} and \cmpd*{c} and \refcmpd{a} and \labelcmpd[pre]{d}`))
      .toEqual(["a", "b", "c", "d"]);
  });

  it("ignores comments but not an escaped percent", () => {
    expect(compoundKeysOnLine(String.raw`85\% \cmpd{a} % \cmpd{b}`)).toEqual(["a"]);
    expect(compoundKeysOnLine(String.raw`% \cmpd{a}`)).toEqual([]);
    expect(compoundKeysOnLine("no compounds here")).toEqual([]);
  });

  it("writes the command that cites a compound", () => {
    expect(compoundCommand("alcohol.OMe")).toBe("\\cmpd{alcohol.OMe}");
  });

  it("reads what \\rcmpd names as the drawing's marks", () => {
    expect(compoundKeysOnLine(String.raw`\node {\rcmpd{A:cat} \cmpd{k} \rcmpd{amine.a.num}};`)).toEqual(["k", "A:cat", "amine.a.num"]);
    expect(compoundMarksOnLine(String.raw`\rcmpd{a} % \rcmpd{b}`)).toEqual(["a"]);
    expect(compoundCommand("A:cat")).toBe(String.raw`\rcmpd{A:cat}`);
    expect(compoundCommand("ketone", true)).toBe(String.raw`\rcmpd{ketone}`);
    expect(compoundCommand("ketone")).toBe(String.raw`\cmpd{ketone}`);
    const numbers = parseCompoundNumbers(String.raw`\cmpdser@aux{A}{cat}{B}` + "\n" + String.raw`\cmpdser@aux{i}{x}{ii}`);
    expect(Object.fromEntries(numbers)).toEqual({ "A:cat": "B", "i:x": "ii" });
    expect(looksLikeCompoundNumber("b")).toBe(true);
    expect(isLoneSmallLetter("b")).toBe(true);
    expect(isLoneSmallLetter("ii")).toBe(false);
  });

  it("shows a key with a style suffix as written, with the number chemnum records for it", () => {
    const numbers = new Map([["amine", "3"], ["amine.a", "3.1"], ["other.a", "4a"]]);
    expect(compoundEntries(["amine.a.num", "other.a"], numbers).map(({ key, number }) => [key, number])).toEqual([
      ["amine", "3"], ["amine.a.num", "3.1"], ["other.a", "4a"],
    ]);
  });

  it("lists no empty key, as a stray \\\\cmpd{} leaves one in the .aux", () => {
    expect(compoundEntries(["a"], new Map([["", "3"]])).map(({ key }) => key)).toEqual(["a"]);
  });

  it("takes a suffix as a format only after a key and a sub, as in a drawing", () => {
    const numbers = new Map([["x", "1"], ["x.num", "1a"], ["amine.a", "2.1"]]);
    const shown = compoundEntries(["x.num", "amine.a.num"], numbers).map(({ key, number }) => [key, number]);
    expect(shown).toEqual([["x", "1"], ["x.num", "1a"], ["amine.a.num", "2.1"]]);
  });

  it("collects the keys of many sources once, across lines", () => {
    expect(compoundKeysIn([String.raw`\cmpd{a}` + "\r\n" + String.raw`\cmpd{b}`, String.raw`\cmpd{a,c}`])).toEqual(["a", "b", "c"]);
  });

  it("reads chemnum's numbers from an .aux, sub-compounds with their letter", () => {
    expect(Object.fromEntries(parseCompoundNumbers(AUX))).toEqual({ ketone: "1", alcohol: "2", "alcohol.OMe": "2a", ten: "10" });
    expect(parseCompoundNumbers("\\relax").size).toBe(0);
  });

  it("reads a label's prefix and suffix, and drops one left as a macro", () => {
    const numbers = parseCompoundNumbers(String.raw`\chemnum@cmpd {c}{7}{7}{S}{}{}{}{\bfseries }
\chemnum@subcmpd {c}{x}{1}{a}
\chemnum@cmpd {b}{2}{II}{}{x}{}{}{\bfseries }
\chemnum@cmpd {k}{3}{3}{}{}{}{.}{\bfseries }
\chemnum@subcmpd {k}{one}{1}{1}
\chemnum@cmpd {ester}{1}{1}{\thechapter -}{}{}{}{\bfseries }`);
    expect(Object.fromEntries(numbers)).toEqual({ c: "S7", "c.x": "S7a", b: "IIx", k: "3", "k.one": "3.1", ester: "1" });
  });

  it("lists numbered compounds in number order, then the unnumbered by key", () => {
    expect(compoundEntries(["zeta", "ten", "alpha", "ketone"], parseCompoundNumbers(AUX)).map(({ key, number }) => [key, number])).toEqual([
      ["ketone", "1"], ["alcohol", "2"], ["alcohol.OMe", "2a"], ["ten", "10"], ["alpha", undefined], ["zeta", undefined],
    ]);
  });
});

describe("keys are data", () => {
  it("drops anything that would be LaTeX when written back", () => {
    expect(compoundKeysOnLine(String.raw`\cmpd{a\input} \rcmpd{b#c} \cmpd{ok.sub} \rcmpd{A:cat}`)).toEqual(["ok.sub", "A:cat"]);
    expect(compoundKeysOnLine(`\\\\cmpd{${"x".repeat(201)}}`)).toEqual([]);
  });

  it("drops such keys from a build's records too, and bounds the list", () => {
    expect(compoundEntries(["good"], new Map([["bad\\\\x", "1"], ["fine", "2"]])).map((entry) => entry.key)).toEqual(["fine", "good"]);
    const many = Array.from({ length: 6000 }, (_, index) => `\\\\cmpd{k${index}}`).join("\n");
    expect(compoundKeysIn([many])).toHaveLength(5000);
  });
});
