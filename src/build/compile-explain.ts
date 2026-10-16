import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { VOCABULARY_COMMANDS } from "../editor/latex/latex-vocabulary";
import { diagnosticSeverity, tokenOffset, type CompileDiagnostic } from "./compile-diagnostics";

/*
 * A failed build in plain words. TeX's own message is read against a small,
 * fixed table of the mistakes papers make most, offline and with no model:
 * each entry gives a headline, a sentence on what went wrong and how to fix
 * it, and, where the log names one, the token TeX stopped at. For an unknown
 * command the fix can be concrete: the closest command this paper already
 * uses (or LaTeX defines), offered only when it is close enough to be a typo.
 * Messages the table does not know stay TeX's own, unchanged.
 */

export type ExcerptLine = { number: number; text: string; failing: boolean; token?: { start: number; end: number } };

export type ExplainedDiagnostic = {
  headline: string;
  explanation: string;
  /** What to mark on the failing line, as written in the source. */
  token?: string;
  /** A replacement for `token` sure enough to offer as one click. */
  suggestion?: string;
  /** The failing line and one either side; empty without the source or a line. */
  excerpt: ExcerptLine[];
};

/** What an entry reads besides the message. */
type ExplainContext = {
  /** The log line `l.<n> …` TeX printed under the error: the text it had read up to where it stopped. */
  context: string | undefined;
  source: string;
  /** Whether the build also failed with an error: a warning after one is often its echo. */
  afterError: boolean;
};

type Explanation = Omit<ExplainedDiagnostic, "excerpt">;

/** The last control sequence TeX read before it stopped: the end of the `l.<n>` context. */
const lastCommand = (context: string | undefined) => (context ? /(\\[A-Za-z@]+)\s*$/.exec(context)?.[1] : undefined);

/** Edits between two command names, a swap of neighbours counting as one: the typo \cietp is one edit from \citep. */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => Array.from({ length: right.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[left.length]![right.length]!;
}

/** The furthest a suggestion may be from what was typed. */
const MAX_EDITS = 2;

/**
 * The command `token` most likely meant: the closest within two edits, a
 * command this paper already uses before one only LaTeX knows, and the more
 * it is used the better. None when nothing is close, when two candidates tie
 * (the guess would be a coin toss), or when the token is so short that two
 * edits reach almost anything.
 */
function closestCommand(token: string, source: string): { name: string; uses: number } | null {
  const uses = new Map<string, number>();
  for (const match of source.matchAll(/\\[A-Za-z@]+/g)) uses.set(match[0], (uses.get(match[0]) ?? 0) + 1);
  uses.delete(token);
  const budget = Math.min(MAX_EDITS, token.length - 3);
  if (budget < 1) return null;
  const candidates = new Set([...uses.keys(), ...VOCABULARY_COMMANDS.map((entry) => entry.name)]);
  let best: { name: string; rank: number } | null = null;
  let tied = false;
  for (const name of candidates) {
    const edits = editDistance(token, name);
    if (edits > budget) continue;
    // Used in this paper beats LaTeX's vocabulary at the same distance, and
    // use breaks a tie between two of the paper's own; never more than one edit's worth.
    const rank = edits - Math.min(0.9, 0.5 + (uses.get(name) ?? -10) / 40);
    if (!best || rank < best.rank) {
      tied = false;
      best = { name, rank };
    } else if (rank === best.rank) tied = true;
  }
  return best && !tied ? { name: best.name, uses: uses.get(best.name) ?? 0 } : null;
}

// Braces go into messages as parameters: in the catalog they would read as placeholders.
const BRACE_OPEN = "{";
const BRACE_CLOSE = "}";
const BEGIN_DOCUMENT = "\\begin{document}";

type Entry = { pattern: RegExp; explain: (match: RegExpExecArray, context: ExplainContext) => Explanation | null };

/** The table. Patterns match TeX's message as the build reports it, with or without the `LaTeX Error: ` prefix. */
const ENTRIES: Entry[] = [
  {
    pattern: /^Undefined control sequence/,
    explain: (_, { context, source }) => {
      const token = lastCommand(context);
      if (!token) return null;
      const close = closestCommand(token, source);
      if (!close) {
        return {
          headline: i18n._(msg`Unknown command ${token}`),
          explanation: i18n._(msg`LaTeX doesn’t know ${token}. Check its spelling, or load the package that defines it.`),
          token,
        };
      }
      const { name, uses } = close;
      return {
        headline: i18n._(msg`Unknown command ${token}`),
        explanation: uses > 1
          ? i18n._(msg`LaTeX doesn’t know ${token}. It looks like a typo for ${name}, which this paper uses ${uses} times.`)
          : i18n._(msg`LaTeX doesn’t know ${token}. It looks like a typo for ${name}.`),
        token,
        suggestion: name,
      };
    },
  },
  {
    pattern: /Environment (\S+) undefined/,
    explain: ([, name = ""]) => ({
      headline: i18n._(msg`Unknown environment ${name}`),
      explanation: i18n._(msg`LaTeX doesn’t know the environment ${name}. Check its spelling in \\begin and \\end, or load the package that defines it.`),
      token: name,
    }),
  },
  {
    pattern: /\\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/,
    explain: ([, opened = "", line = "", closed = ""]) => {
      // The LaTeX goes in as parameters: its braces would read as placeholders.
      const begin = `\\begin{${opened}}`;
      const end = `\\end{${closed}}`;
      const missing = `\\end{${opened}}`;
      return {
        headline: i18n._(msg`${begin} is closed by ${end}`),
        explanation: i18n._(msg`Environments close in the reverse order they open. The ${opened} environment from line ${line} needs its ${missing} before this one.`),
        token: end,
      };
    },
  },
  {
    pattern: /^Missing \$ inserted/,
    explain: () => ({
      headline: i18n._(msg`Math outside math mode`),
      explanation: i18n._(msg`This line uses a math-only command or character, such as _ or ^, outside $…$. Put the math in $…$, or write \\_ for a literal underscore.`),
    }),
  },
  {
    pattern: /^Extra \}, or forgotten \$/,
    explain: () => ({
      headline: i18n._(msg`A ${BRACE_CLOSE} with no ${BRACE_OPEN} before it`),
      explanation: i18n._(msg`This line closes a group that was never opened, or leaves math mode with a ${BRACE_CLOSE} before its $. Remove the extra ${BRACE_CLOSE}, or add the ${BRACE_OPEN} it closes.`),
    }),
  },
  {
    pattern: /^(?:Missing \} inserted|File ended while scanning use of (\\\S+?)\.?$)/,
    explain: ([, command]) => ({
      headline: i18n._(msg`A ${BRACE_OPEN} is never closed`),
      explanation: command
        ? i18n._(msg`The argument of ${command} runs to the end of the file. Add the ${BRACE_CLOSE} it is missing.`)
        : i18n._(msg`A group opened before this point is still open. Add the ${BRACE_CLOSE} it is missing.`),
      ...(command ? { token: command } : {}),
    }),
  },
  {
    pattern: /^Paragraph ended before (\\\S+?) was complete/,
    explain: ([, command = ""]) => ({
      headline: i18n._(msg`${command} runs past a blank line`),
      explanation: i18n._(msg`The argument of ${command} contains a blank line, which usually means a missing ${BRACE_CLOSE}. Close the argument before the paragraph ends.`),
      token: command,
    }),
  },
  {
    pattern: /^Extra alignment tab has been changed/,
    explain: () => ({
      headline: i18n._(msg`Too many & in a table row`),
      explanation: i18n._(msg`This row has more cells than the table has columns. Remove an &, or add a column to the table’s column spec.`),
      token: "&",
    }),
  },
  {
    pattern: /^Misplaced alignment tab character &/,
    explain: () => ({
      headline: i18n._(msg`An & outside a table`),
      explanation: i18n._(msg`& separates the cells of a table or an aligned equation. To print an ampersand, write \\&.`),
      token: "&",
    }),
  },
  {
    pattern: /^Double (sub|super)script/,
    explain: ([, kind]) => {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX source
      const grouped = kind === "sub" ? "x_{i_j}" : "x^{a^b}";
      // eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX source
      const flat = kind === "sub" ? "x_i_j" : "x^a^b";
      return {
        headline: kind === "sub" ? i18n._(msg`Two subscripts in a row`) : i18n._(msg`Two superscripts in a row`),
        explanation: i18n._(msg`Group a nested script in braces: write ${grouped} rather than ${flat}.`),
      };
    },
  },
  {
    pattern: /File [`']([^`']+)' not found/,
    explain: ([, file = ""]) => ({
      headline: i18n._(msg`File not found: ${file}`),
      explanation: i18n._(msg`Nothing in the project is called ${file}. Check the path and its letter case; paths are relative to the root document.`),
      token: file,
    }),
  },
  {
    pattern: /Missing \\begin\{document\}/,
    explain: () => ({
      headline: i18n._(msg`Text before ${BEGIN_DOCUMENT}`),
      explanation: i18n._(msg`Only definitions and \\usepackage belong in the preamble. Move this text after ${BEGIN_DOCUMENT}, or check for a stray character above it.`),
    }),
  },
  {
    pattern: /Can be used only in preamble/,
    explain: (_, { context }) => {
      const token = lastCommand(context);
      return {
        headline: i18n._(msg`A preamble command inside the document`),
        explanation: i18n._(msg`Commands such as \\usepackage only work before ${BEGIN_DOCUMENT}. Move this line into the preamble.`),
        ...(token ? { token } : {}),
      };
    },
  },
  {
    pattern: /Option clash for package (\S+?)\.?$/,
    explain: ([, name = ""]) => ({
      headline: i18n._(msg`${name} is loaded twice with different options`),
      explanation: i18n._(msg`Another package or the template already loads ${name}. Pass your options with \\PassOptionsToPackage before \\documentclass, or remove the second \\usepackage.`),
    }),
  },
  {
    pattern: /^Illegal unit of measure/,
    explain: () => ({
      headline: i18n._(msg`A length without a unit`),
      explanation: i18n._(msg`Lengths need a unit: write 0.5\\linewidth, 2em or 10pt rather than a bare number.`),
    }),
  },
  {
    pattern: /^Citation [`']([^']+)' (?:on page \S+ )?undefined/,
    explain: ([, key = ""], { afterError }) => ({
      headline: i18n._(msg`No entry for ${key}`),
      explanation: afterError
        ? i18n._(msg`No bibliography entry has the key ${key} yet. A build that stops at an error never reads the bibliography, so this may clear once the error above is fixed.`)
        : i18n._(msg`No bibliography entry has the key ${key}. Check the key, or add the entry to the .bib file.`),
      token: key,
    }),
  },
  {
    pattern: /^Reference [`']([^']+)' (?:on page \S+ )?undefined/,
    explain: ([, label = ""]) => {
      const command = `\\label{${label}}`;
      return {
        headline: i18n._(msg`No label ${label}`),
        explanation: i18n._(msg`Nothing in the paper has ${command}. Check the spelling, or add the label where the reference should point.`),
        token: label,
      };
    },
  },
  {
    pattern: /^Label [`']([^']+)' multiply defined/,
    explain: ([, label = ""]) => {
      const command = `\\label{${label}}`;
      return {
        headline: i18n._(msg`The label ${label} is used twice`),
        explanation: i18n._(msg`Two places set ${command}, so references to it may point at the wrong one. Rename one of them.`),
        token: label,
      };
    },
  },
  {
    pattern: /^Overfull \\hbox \(([\d.]+)pt too wide\)/,
    explain: ([, points = ""]) => ({
      headline: i18n._(msg`A line runs ${points} pt into the margin`),
      explanation: i18n._(msg`LaTeX couldn’t break this line inside the text width. Rephrasing it, or allowing a hyphen in a long word, usually fixes it.`),
    }),
  },
  {
    pattern: /^Float too large for page by ([\d.]+)pt/,
    explain: ([, points = ""]) => ({
      headline: i18n._(msg`A figure or table is ${points} pt taller than the page`),
      explanation: i18n._(msg`Scale it down, for example with width=\\linewidth or a smaller height, so it fits on one page.`),
    }),
  },
];

/** The text TeX had read on `line` when it stopped: the log's `l.<line> …` line. */
function failingContext(log: string, line: number | undefined): string | undefined {
  if (!line) return undefined;
  return new RegExp(`^l\\.${line} (.*)$`, "m").exec(log)?.[1];
}

/** The failing line and one either side, with `token` located on the failing one. */
function excerptAround(source: string, line: number | undefined, token?: string): ExcerptLine[] {
  if (!source || !line) return [];
  const lines = source.split("\n");
  if (line > lines.length) return [];
  const excerpt: ExcerptLine[] = [];
  for (let number = Math.max(1, line - 1); number <= Math.min(lines.length, line + 1); number += 1) {
    const text = lines[number - 1] ?? "";
    const failing = number === line;
    const at = failing && token ? tokenOffset(text, token) : -1;
    excerpt.push({ number, text, failing, ...(at >= 0 && token ? { token: { start: at, end: at + token.length } } : {}) });
  }
  return excerpt;
}

/**
 * Plain words for one diagnostic: null for one the table does not know, or
 * for Lattice's own advice (which is already in plain words).
 */
export function explainDiagnostic(
  diagnostic: CompileDiagnostic,
  { log, source, afterError }: { log: string; source: string | null; afterError: boolean },
): ExplainedDiagnostic | null {
  if (diagnostic.code) return null;
  const message = diagnostic.message.trim().replace(/^(?:LaTeX|Package \S+) (?:Error|Warning):\s*/, "");
  for (const entry of ENTRIES) {
    const match = entry.pattern.exec(message);
    if (!match) continue;
    const explained = entry.explain(match, { context: failingContext(log, diagnostic.line), source: source ?? "", afterError });
    if (!explained) return null;
    // Only an error stops TeX on the line it names; a warning's line is where it noticed.
    const errorLine = diagnosticSeverity(diagnostic.level) === "error" ? diagnostic.line : undefined;
    return { ...explained, excerpt: source ? excerptAround(source, errorLine, explained.token) : [] };
  }
  return null;
}
