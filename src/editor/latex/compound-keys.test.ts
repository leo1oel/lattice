import { describe, expect, it } from "vitest";
import { withoutCounterPrefix, compoundCommand, compoundMarksOnLine, compoundEntries, compoundKeysIn, compoundKeysOnLine, keysNumbered, parseCompoundNumbers, printedNumber } from "./compound-keys";

const AUX = String.raw`\chemnum@cmpd {ketone}{1}{1}{}{}{}{}{\bfseries }
\chemnum@cmpd {alcohol}{2}{2}{}{}{}{}{\bfseries }
\chemnum@subcmpd {alcohol}{OMe}{1}{a}
\chemnum@cmpd {ten}{10}{10}{}{}{}{}{\bfseries }
\chemnum@check `;

describe("compound keys", () => {
  it("takes PDF text as a compound's only where the build gave that compound the number", () => {
    const numbers = new Map([["ketone", "1"], ["alcohol", "2"], ["alcohol.OMe", "2a"], ["amine.a", "3.1"], ["a:x", "b"]]);
    const line = ["ketone", "alcohol", "alcohol.OMe", "amine.a.num", "a:x"];
    expect(keysNumbered("(2a),", line, numbers)).toEqual(["alcohol.OMe"]);
    expect(keysNumbered(" 1 ", line, numbers)).toEqual(["ketone"]);
    expect(keysNumbered("3.1", line, numbers)).toEqual(["amine.a.num"]);
    expect(keysNumbered("b", line, numbers)).toEqual(["a:x"]);
    // A citation number, a year or a word on the same source line names none.
    expect(keysNumbered("[12]", line, numbers)).toEqual([]);
    expect(keysNumbered("2023", line, numbers)).toEqual([]);
    expect(keysNumbered("a", line, numbers)).toEqual([]);
    expect(keysNumbered("", line, new Map([["", ""]]))).toEqual([]);
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

  it("reads crafted sources and build records in linear time", () => {
    // Each of these rescanned to the end of the text from every start when a
    // pattern's class could cross a brace or bracket: 80k characters took
    // 140-420 ms, and the 2 MB a source may hold minutes.
    const size = 400_000;
    const started = performance.now();
    parseCompoundNumbers("\\chemnum@cmpd {".repeat(size / 15));
    parseCompoundNumbers("\\chemnum@subcmpd {".repeat(size / 18));
    parseCompoundNumbers("\\cmpdser@aux {A}{".repeat(size / 18));
    compoundKeysIn(["\\cmpd[".repeat(size / 6)]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("drops such keys from a build's records too, and bounds the list", () => {
    expect(compoundEntries(["good"], new Map([["bad\\\\x", "1"], ["fine", "2"]])).map((entry) => entry.key)).toEqual(["fine", "good"]);
    const many = Array.from({ length: 6000 }, (_, index) => `\\\\cmpd{k${index}}`).join("\n");
    expect(compoundKeysIn([many])).toHaveLength(5000);
  });
});

describe("a number printed with a chapter in its own run of text", () => {
  // As chemnum writes it for pre-label-code=\textbf{\thechapter-}.
  const aux = String.raw`\chemnum@cmpd {a}{1}{1}{\textbf {\thechapter -}}{}{}{}{\bfseries }
\chemnum@cmpd {b}{2}{2}{\textbf {\thechapter -}}{}{}{}{\bfseries }
\chemnum@subcmpd {b}{x}{1}{a}`;
  const numbers = parseCompoundNumbers(aux);

  it("is the compound's, sub-compounds too", () => {
    expect(keysNumbered("1-1,", ["a", "b"], numbers)).toEqual(["a"]);
    expect(keysNumbered("2-2a", ["b.x", "a"], numbers)).toEqual(["b.x"]);
    expect(keysNumbered("1", ["a"], numbers)).toEqual(["a"]);
  });

  it("does not match what the line also prints", () => {
    expect(keysNumbered("2023", ["a", "b"], numbers)).toEqual([]);
    expect(keysNumbered("1-3", ["a", "b"], numbers)).toEqual([]);
    expect(withoutCounterPrefix("[1]", numbers)).toBe("");
  });

  it("needs a macro prefix: a plain build's 4-1 is only its own number", () => {
    const plain = parseCompoundNumbers(String.raw`\chemnum@cmpd {a}{1}{1}{}{}{}{}{\bfseries }`);
    expect(keysNumbered("4-1", ["a"], plain)).toEqual([]);
    expect(withoutCounterPrefix("4-1", plain)).toBe("");
  });
});

describe("printedNumber", () => {
  it("drops the brackets and punctuation around a printed number", () => {
    expect(printedNumber(" (2a), ")).toBe("2a");
    expect(printedNumber("[3.1];")).toBe("3.1");
    expect(printedNumber("((1)).:")).toBe("1");
    expect(printedNumber("2a)!")).toBe("2a)!");
    expect(printedNumber("),.;:")).toBe("");
    expect(printedNumber("")).toBe("");
  });

  it("stays linear on a long punctuation run that is not at the end", () => {
    const text = `${")".repeat(100_000)}!`;
    const started = performance.now();
    expect(printedNumber(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
