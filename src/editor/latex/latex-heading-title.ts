/**
 * A heading's argument as a reader sees it in the outline: escapes and TeX
 * accents resolved, font switches dropped, labels and notes left out. Math
 * and any command it does not know stay as written, since guessing at either
 * would show a title the document does not have.
 */
import { groupEnd } from "./latex-visible-source";

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX command names and the glyphs they stand for */
/** Commands whose one argument is the text itself. */
const WRAPPERS = new Set([
  "textbf", "textit", "textsl", "textsc", "textup", "textmd", "textrm", "textsf", "texttt", "textnormal",
  "emph", "underline", "mbox", "hbox", "text", "uppercase", "lowercase", "MakeUppercase", "MakeLowercase",
]);
/** Commands that print nothing in a title. */
const SILENT = new Set(["protect", "relax", "/", "@", "-", "noindent", "nobreak", "boldmath", "unboldmath",
  "bfseries", "itshape", "scshape", "slshape", "upshape", "mdseries", "rmfamily", "sffamily", "ttfamily",
  "normalfont", "bf", "it", "sc", "sl", "rm", "sf", "tt", "em", "small", "large", "Large", "footnotesize"]);
/** Commands whose argument is not part of the title. */
const DROPPED = new Set(["label", "footnote", "thanks", "index", "footnotemark", "hspace", "vspace", "phantom"]);
/** Escaped characters and spacing commands, and what they print. */
const LITERAL: Record<string, string> = {
  "&": "&", "%": "%", "$": "$", "#": "#", "_": "_", "{": "{", "}": "}", " ": " ", "\\": " ", ",": " ",
  ";": " ", "quad": " ", "qquad": " ", "newline": " ", "linebreak": " ", "ldots": "…", "dots": "…",
  "textendash": "–", "textemdash": "—", "S": "§", "P": "¶", "copyright": "©", "pounds": "£",
  "ss": "ß", "o": "ø", "O": "Ø", "ae": "æ", "AE": "Æ", "oe": "œ", "OE": "Œ", "aa": "å", "AA": "Å",
  "l": "ł", "L": "Ł", "i": "ı", "j": "ȷ", "LaTeX": "LaTeX", "TeX": "TeX",
};
/** Accent commands, as the combining mark each puts over (or under) its letter. */
const ACCENTS: Record<string, string> = {
  "'": "́", "`": "̀", "^": "̂", "\"": "̈", "~": "̃", "=": "̄", ".": "̇",
  u: "̆", v: "̌", H: "̋", r: "̊", c: "̧", k: "̨", d: "̣", b: "̱",
};
/* eslint-enable lingui/no-unlocalized-strings */

/** The math that opens at `at` (`$…$`, `$$…$$`, `\(…\)`), as its end; null when none does or it never closes. */
function mathEnd(text: string, at: number): number | null {
  const delimiter = text.startsWith("$$", at) ? "$$" : text[at] === "$" ? "$" : text.startsWith("\\(", at) ? "\\)" : null;
  if (!delimiter) return null;
  for (let index = at + (delimiter === "\\)" ? 2 : delimiter.length); index < text.length; index++) {
    if (text.startsWith(delimiter, index)) return index + delimiter.length;
    if (text[index] === "\\") index++;
  }
  return null;
}

/** The argument at `at` after optional spaces: a braced group's inside, or one character. */
function argumentAt(text: string, at: number): { value: string; end: number } | null {
  while (text[at] === " ") at++;
  const end = groupEnd(text, at);
  if (end != null) return { value: text.slice(at + 1, end - 1), end };
  if (at >= text.length || text[at] === "}") return null;
  if (text[at] === "\\") {
    let name = at + 1;
    while (/[A-Za-z]/.test(text[name] ?? "")) name++;
    const stop = name === at + 1 ? name + 1 : name;
    // A control word (`\i`) swallows the spaces after it.
    let end = stop;
    if (stop === name) while (text[end] === " ") end++;
    return { value: text.slice(at, stop), end };
  }
  return { value: text[at], end: at + 1 };
}

/** Past optional `[…]` groups and braced groups after `at` (a command's arguments as written). */
function argumentsEnd(text: string, at: number): number {
  for (;;) {
    const end = groupEnd(text, at, "[", "]") ?? groupEnd(text, at);
    if (end == null) return at;
    at = end;
  }
}

function render(text: string): string {
  let out = "";
  for (let index = 0; index < text.length;) {
    const char = text[index];
    const math = char === "$" || text.startsWith("\\(", index) ? mathEnd(text, index) : null;
    if (math != null) {
      out += text.slice(index, math);
      index = math;
      continue;
    }
    if (char === "{" || char === "}") {
      index++;
      continue;
    }
    if (char === "~") {
      out += " ";
      index++;
      continue;
    }
    if (char !== "\\") {
      out += char;
      index++;
      continue;
    }
    let nameEnd = index + 1;
    while (/[A-Za-z]/.test(text[nameEnd] ?? "")) nameEnd++;
    if (nameEnd === index + 1) nameEnd = Math.min(index + 2, text.length);
    const name = text.slice(index + 1, nameEnd);
    const letters = /^[A-Za-z]/.test(name);
    // A control word swallows the spaces after it, as TeX reads it.
    const after = letters ? nameEnd + (text.slice(nameEnd).match(/^ */)?.[0].length ?? 0) : nameEnd;
    if (name === "texorpdfstring") {
      // The second argument is the plain-text form PDF bookmarks show.
      const tex = argumentAt(text, after);
      const plain = tex && argumentAt(text, tex.end);
      if (plain) {
        out += render(plain.value);
        index = plain.end;
        continue;
      }
    }
    const accent = ACCENTS[name];
    const accented = accent != null ? argumentAt(text, letters ? after : nameEnd) : null;
    if (accented) {
      // A dotless ı or ȷ under an accent is the plain letter TeX's accent sits on.
      // eslint-disable-next-line lingui/no-unlocalized-strings -- letters, not prose
      out += (render(accented.value).replace(/^ı/, "i").replace(/^ȷ/, "j") + accent).normalize("NFC");
      index = accented.end;
      continue;
    }
    if (WRAPPERS.has(name)) {
      const argument = argumentAt(text, after);
      out += argument ? render(argument.value) : "";
      index = argument?.end ?? after;
      continue;
    }
    if (DROPPED.has(name)) {
      index = argumentsEnd(text, text[after] === "*" ? after + 1 : after);
      continue;
    }
    if (SILENT.has(name)) {
      index = after;
      continue;
    }
    if (name in LITERAL) {
      out += LITERAL[name];
      // `\LaTeX{}`: the empty group only ends the command name.
      index = text.startsWith("{}", after) ? after + 2 : after;
      continue;
    }
    // Unknown: keep the command and its arguments as written.
    const end = argumentsEnd(text, nameEnd);
    out += text.slice(index, end);
    index = end;
  }
  return out;
}

/** The title a heading's argument shows, whitespace collapsed; empty when it prints nothing. */
export function headingTitle(argument: string): string {
  return render(argument).replace(/\s+/g, " ").trim();
}
