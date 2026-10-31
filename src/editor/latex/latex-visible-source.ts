/**
 * The LaTeX source a structure scan should read: the text with what TeX never
 * typesets as document structure blanked out. Blanking (every character but a
 * line break becomes a space) keeps each offset and line number of the
 * original, so a match in the result points at the same place in the source.
 */

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX environment and command names */
/** Environments whose body TeX reads as literal text, not as commands. */
const LITERAL_ENVIRONMENTS = new Set([
  "verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "LVerbatim",
  "lstlisting", "minted", "comment", "filecontents", "filecontents*",
]);
/** `\newcommand` and kin: a name, then `[arity]`, `[default]`, and one body. */
const COMMAND_DEFINITIONS = new Set(["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"]);
/** `\newenvironment` and kin: a name, then `[arity]`, `[default]`, and two bodies. */
const ENVIRONMENT_DEFINITIONS = new Set(["newenvironment", "renewenvironment"]);
/** xparse: a name, an argument specification, then one body (commands) or two (environments). */
const DOCUMENT_COMMANDS = new Set(["NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand", "DeclareDocumentCommand"]);
const DOCUMENT_ENVIRONMENTS = new Set(["NewDocumentEnvironment", "RenewDocumentEnvironment", "ProvideDocumentEnvironment", "DeclareDocumentEnvironment"]);
/** Primitive definitions: a control sequence, a parameter text, then one body. */
const PRIMITIVE_DEFINITIONS = new Set(["def", "gdef", "edef", "xdef"]);
/* eslint-enable lingui/no-unlocalized-strings */

/** A comment's start, a command that may open skipped text, or an escaped character to step over. */
const SKIPPABLE = new RegExp(`%|\\\\(${[
  "begin", "verb", ...PRIMITIVE_DEFINITIONS, ...COMMAND_DEFINITIONS, ...ENVIRONMENT_DEFINITIONS,
  ...DOCUMENT_COMMANDS, ...DOCUMENT_ENVIRONMENTS,
].join("|")})(?![A-Za-z@])|\\\\[^A-Za-z@]`);

const isLetter = (char: string | undefined) => char != null && /[A-Za-z@]/.test(char);

/** Where the whitespace starting at `at` ends. */
export function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}

/** Where the comment or escaped pair at `at` ends, or `at` when neither starts there. */
function skipInert(text: string, at: number): number {
  if (text[at] === "\\") return at + 2;
  if (text[at] === "%") {
    const end = text.indexOf("\n", at);
    return end === -1 ? text.length : end;
  }
  return at;
}

/**
 * The end (exclusive) of the group opened by `open` at `at`, counting nested
 * braces and ignoring escaped characters and comments. Null when no such
 * group starts at `at`, or it never closes: a brace just typed must not
 * swallow the rest of the document.
 */
export function groupEnd(text: string, at: number, open = "{", close = "}"): number | null {
  if (text[at] !== open) return null;
  let braces = 0;
  for (let index = at + 1; index < text.length; index++) {
    const inert = skipInert(text, index);
    if (inert !== index) {
      index = inert - 1;
      continue;
    }
    const char = text[index];
    if (char === close && braces === 0) return index + 1;
    if (char === "{") braces++;
    else if (char === "}") {
      // A stray `}` inside `[…]` closes the group that holds the brackets.
      if (braces === 0) return null;
      braces--;
    }
  }
  return null;
}

/** The control sequence at `at` (a backslash and its name), as [name, end]; null when none starts there. */
function controlSequence(text: string, at: number): [string, number] | null {
  if (text[at] !== "\\" || at + 1 >= text.length) return null;
  let end = at + 1;
  while (isLetter(text[end])) end++;
  if (end === at + 1) end++;
  return [text.slice(at + 1, end), end];
}

/** Past optional `[…]` groups after `at` (at most `limit`). */
function skipOptions(text: string, at: number, limit: number): number {
  for (let count = 0; count < limit; count++) {
    const start = skipSpace(text, at);
    const end = groupEnd(text, start, "[", "]");
    if (end == null) return at;
    at = end;
  }
  return at;
}

/** Past `count` braced groups after `at`; where the last complete one ends. */
function skipGroups(text: string, at: number, count: number): number {
  for (let index = 0; index < count; index++) {
    const start = skipSpace(text, at);
    const end = groupEnd(text, start);
    if (end == null) return at;
    at = end;
  }
  return at;
}

/** A definition's name: `{\name}`, `\name`, or an environment's `{name}`. */
function skipName(text: string, at: number): number {
  const start = skipSpace(text, at);
  return groupEnd(text, start) ?? controlSequence(text, start)?.[1] ?? at;
}

/** Where the definition introduced by `name` (whose command ends at `at`) ends; null when `name` defines nothing. */
function definitionEnd(text: string, name: string, at: number): number | null {
  if (PRIMITIVE_DEFINITIONS.has(name)) {
    const target = controlSequence(text, skipSpace(text, at));
    if (!target) return null;
    // The parameter text (`#1#2`, delimiters) runs to the body's brace.
    const body = text.indexOf("{", target[1]);
    return body === -1 ? null : groupEnd(text, body);
  }
  if (text[at] === "*") at++;
  if (COMMAND_DEFINITIONS.has(name)) return skipGroups(text, skipOptions(text, skipName(text, at), 2), 1);
  if (ENVIRONMENT_DEFINITIONS.has(name)) return skipGroups(text, skipOptions(text, skipName(text, at), 2), 2);
  if (DOCUMENT_COMMANDS.has(name)) return skipGroups(text, skipName(text, at), 2);
  if (DOCUMENT_ENVIRONMENTS.has(name)) return skipGroups(text, skipName(text, at), 3);
  return null;
}

/** Where the literal text a command at `at` opens ends: a verbatim environment or `\verb`; null for any other command. */
function literalEnd(text: string, name: string, at: number): number | null {
  if (name === "verb") {
    const delimiter = text[at] === "*" ? at + 1 : at;
    if (delimiter >= text.length || /[\sA-Za-z]/.test(text[delimiter])) return null;
    const close = text.indexOf(text[delimiter], delimiter + 1);
    const line = text.indexOf("\n", delimiter + 1);
    return close !== -1 && (line === -1 || close < line) ? close + 1 : null;
  }
  if (name !== "begin") return null;
  const start = skipSpace(text, at);
  const end = groupEnd(text, start);
  const environment = end == null ? null : text.slice(start + 1, end - 1);
  if (environment == null || !LITERAL_ENVIRONMENTS.has(environment)) return null;
  const close = text.indexOf(`\\end{${environment}}`, end!);
  return close === -1 ? text.length : close + `\\end{${environment}}`.length;
}

function blankIgnored(source: string): string {
  const parts: string[] = [];
  let kept = 0;
  const blank = (from: number, to: number, oneLine = false) => {
    parts.push(source.slice(kept, from), oneLine ? " ".repeat(to - from) : source.slice(from, to).replace(/[^\n]/g, " "));
    kept = to;
  };
  // The regex jumps between the only places that matter, which keeps a
  // whole-document pass on every edit cheap.
  const tokens = new RegExp(SKIPPABLE.source, "g");
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const at = match.index;
    if (match[0] === "%") {
      const end = skipInert(source, at);
      blank(at, end, true);
      tokens.lastIndex = end;
      continue;
    }
    // An escaped character (`\%`, `\\`) is only stepped over.
    if (match[1] == null) continue;
    const end = at + match[0].length;
    const skipped = literalEnd(source, match[1], end) ?? definitionEnd(source, match[1], end);
    if (skipped == null) continue;
    blank(at, skipped);
    tokens.lastIndex = skipped;
  }
  if (kept === 0) return source;
  parts.push(source.slice(kept));
  return parts.join("");
}

/**
 * Recent results by source. The outline, the include walk and the body's end
 * each read every manuscript file on every edit; with this, the files the
 * edit did not touch cost a lookup rather than another pass.
 */
const recent = new Map<string, string>();
const RECENT_LIMIT = 32;

/**
 * `source` with comments, verbatim-like environments (`verbatim`,
 * `lstlisting`, `minted`, `comment`, …), `\verb|…|`, and macro definitions
 * (`\newcommand`, `\def`, `\newenvironment`, `\NewDocumentCommand`, … with
 * their bodies) blanked out. A heading, include, or `\appendix` left in the
 * result is one the document itself reads, not one quoted or defined for later.
 */
export function visibleLatexSource(source: string): string {
  const cached = recent.get(source);
  if (cached != null) return cached;
  const visible = blankIgnored(source);
  recent.set(source, visible);
  if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!);
  return visible;
}
