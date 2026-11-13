import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  latexSelectionFormats, setLatexHeading, toggleLatexInline, toggleLatexMath, toggleLatexQuote,
  type FormatEdit, type LatexInlineFormat,
} from "./latex-format-toggle";

/**
 * `source` marks the selection with `[` and `]` (or a caret with `|`); the
 * result is the edited text with the selection after the edit marked the
 * same way, so a toggle and what it selects read in one string.
 */
function run(source: string, edit: (doc: Text, from: number, to: number) => FormatEdit): string {
  const caret = source.indexOf("|");
  const from = caret >= 0 ? caret : source.indexOf("[");
  const to = caret >= 0 ? caret : source.indexOf("]") - 1;
  const doc = Text.of(source.replace(/[[\]|]/g, "").split("\n"));
  const result = edit(doc, from, to);
  const text = ChangeSet.of(result.changes, doc.length).apply(doc).toString();
  const { anchor, head } = result.selection;
  return anchor === head
    ? `${text.slice(0, anchor)}|${text.slice(anchor)}`
    : `${text.slice(0, anchor)}[${text.slice(anchor, head)}]${text.slice(head)}`;
}

const inline = (format: LatexInlineFormat) => (doc: Text, from: number, to: number) => toggleLatexInline(doc, from, to, format);
const plain = (source: string) => source.replace(/[[\]|]/g, "");

const COMMANDS: [LatexInlineFormat, string][] = [
  ["bold", "textbf"],
  ["italic", "textit"],
  ["emphasis", "emph"],
  ["underline", "underline"],
  ["strikethrough", "sout"],
];

describe.each(COMMANDS)("toggling %s", (format, command) => {
  const on = inline(format);
  const wrapped = (text: string) => `\\${command}{${text}}`;

  it("applies once, then the same click takes it off", () => {
    const formatted = run("Toggle [these words] please.", on);
    expect(formatted).toBe(`Toggle ${wrapped("[these words]")} please.`);
    expect(run(formatted, on)).toBe("Toggle [these words] please.");
  });

  it("never nests, however often it is applied to the same text", () => {
    let source = "Toggle [these words] please.";
    for (let click = 0; click < 5; click += 1) source = run(source, on);
    expect(plain(source)).toBe(`Toggle ${wrapped("these words")} please.`);
  });

  it("takes the format off a selection that covers the hidden command too", () => {
    expect(run(`Toggle [${wrapped("these words")}] please.`, on)).toBe("Toggle [these words] please.");
  });

  it("leaves the selection's edge whitespace out of the command", () => {
    expect(run("Toggle[ these words ]please.", on)).toBe(`Toggle ${wrapped("[these words]")} please.`);
    expect(run(`Toggle[ ${wrapped("these words")} ]please.`, on)).toBe("Toggle [these words] please.");
  });

  it("splits a group when only part of its text is selected", () => {
    expect(run(`${wrapped("one [two] three")}`, on)).toBe(`${wrapped("one")} [two] ${wrapped("three")}`);
    expect(run(`${wrapped("[one] two")}`, on)).toBe(`[one] ${wrapped("two")}`);
    expect(run(`${wrapped("one [two]")}`, on)).toBe(`${wrapped("one")} [two]`);
  });

  it("keeps no command around the space a split leaves", () => {
    expect(run(`these${wrapped(" [words]")} please`, on)).toBe("these [words] please");
    expect(run(`${wrapped("[these] ")}words`, on)).toBe("[these] words");
  });

  it("applies once over a partly formatted selection, absorbing the groups it overlaps", () => {
    expect(run(`[a ${wrapped("b")} c]`, on)).toBe(wrapped("[a b c]"));
    expect(run(`${wrapped("a [b")} c] d`, on)).toBe(`${wrapped("[a b c]")} d`);
    expect(run(`a [b ${wrapped("c] d")}`, on)).toBe(`a ${wrapped("[b c d]")}`);
  });

  it("takes a caret into an empty pair, and the pair away again", () => {
    expect(run("a | b", on)).toBe(`a \\${command}{|} b`);
    expect(run(`a \\${command}{|} b`, on)).toBe("a | b");
  });
});

describe("inline toggles", () => {
  it("collapses the nesting the old Bold left behind in one click", () => {
    expect(run("Toggle \\textbf{\\textbf{\\textbf{[these words]}}} please.", inline("bold"))).toBe("Toggle [these words] please.");
  });

  it("keeps other formats in place", () => {
    expect(run("\\textit{\\textbf{[word]}}", inline("bold"))).toBe("\\textit{[word]}");
    expect(run("\\textbf{[word]}", inline("italic"))).toBe("\\textbf{\\textit{[word]}}");
  });

  it("treats \\emph and \\textit as one italic", () => {
    expect(run("\\emph{[word]}", inline("italic"))).toBe("[word]");
    expect(run("\\textit{[word]}", inline("emphasis"))).toBe("[word]");
    expect(run("\\emph{one [two]}", inline("italic"))).toBe("\\emph{one} [two]");
  });

  it("does not cut a selection that crosses braces out of a group", () => {
    expect(run("\\textbf{a \\textit{[b} c]}", inline("bold"))).toBe("[a \\textit{b} c]");
  });

  it("ignores commands in comments and escaped backslashes", () => {
    expect(run("% \\textbf{x}\n[word]", inline("bold"))).toBe("% \\textbf{x}\n\\textbf{[word]}");
    expect(run("\\\\textbf{[word]}", inline("bold"))).toBe("\\\\textbf{\\textbf{[word]}}");
  });

  it("keeps the brace a comment holds out of the group's end", () => {
    expect(run("\\textbf{[a] % }\n}", inline("bold"))).toBe("[a] \\textbf{% }\n}");
  });
});

describe("headings", () => {
  const heading = (command: string) => (doc: Text, from: number, to: number) => setLatexHeading(doc, from, to, command);

  it("makes a heading, takes the same level off and changes another", () => {
    const section = run("[Intro]", heading("section"));
    expect(section).toBe("\\section{[Intro]}");
    expect(run(section, heading("section"))).toBe("[Intro]");
    expect(run(section, heading("subsection"))).toBe("\\subsection{[Intro]}");
  });

  it("acts on the whole heading from part of its title", () => {
    expect(run("\\section{An [intro]}", heading("section"))).toBe("[An intro]");
    expect(run("\\section*{An [intro]}", heading("chapter"))).toBe("\\chapter*{[An intro]}");
  });
});

describe("quote", () => {
  it("wraps once and unwraps from inside", () => {
    const quoted = run("Before\n[A line.]\nAfter", toggleLatexQuote);
    expect(quoted).toBe("Before\n\\begin{quote}\n[A line.]\n\\end{quote}\nAfter");
    expect(run(quoted, toggleLatexQuote)).toBe("Before\n[A line.]\nAfter");
    expect(run("\\begin{quote}\nA [line].\n\\end{quote}", toggleLatexQuote)).toBe("[A line.]");
  });
});

describe("inline math", () => {
  it("toggles from the body or the whole formula", () => {
    const math = run("so [x+1] is", toggleLatexMath);
    expect(math).toBe("so $[x+1]$ is");
    expect(run(math, toggleLatexMath)).toBe("so [x+1] is");
    expect(run("so [$x+1$] is", toggleLatexMath)).toBe("so [x+1] is");
  });

  it("does not mistake display math for inline", () => {
    expect(plain(run("$$[x]$$", toggleLatexMath))).toBe("$$$x$$$");
  });
});

describe("latexSelectionFormats", () => {
  const formats = (source: string) => {
    const from = source.indexOf("[");
    const to = source.indexOf("]") - 1;
    return latexSelectionFormats(Text.of([plain(source)]), from, to);
  };

  it("reports the formats the whole selection is in", () => {
    const read = formats("\\section{\\textbf{\\emph{[word]}} more}");
    expect([...read.inline].sort()).toEqual(["bold", "italic"]);
    expect(read.heading).toBe("section");
    expect(read.quote).toBe(false);
  });

  it("reports none for a selection only partly formatted", () => {
    expect([...formats("[a \\textbf{b}]").inline]).toEqual([]);
    expect([...formats("\\sout{[a]} \\underline{b}").inline]).toEqual(["strikethrough"]);
  });
});
