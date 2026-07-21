import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import { linter } from "@codemirror/lint";
import {
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Prec, Transaction, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, tooltips, type Rect } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { latexCompletionSource } from "codemirror-lang-latex";
import { matchingMathDelimiter, unclosedMathDiagnostics } from "./math-region";
import {
  resolveTexlabDefinition,
  texlabCompletionSource,
  texlabHoverTooltip,
} from "./texlab-language";

const CITATION_COMMANDS = "cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite";
const REFERENCE_COMMANDS = "ref|eqref|pageref|autoref|cref|Cref";
const BRACED_COMMANDS = new RegExp(`\\\\(?:${CITATION_COMMANDS}|${REFERENCE_COMMANDS}|label|input|include)$`);
const OPEN_CITATION = new RegExp(`\\\\(?:${CITATION_COMMANDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)$`);
const OPEN_REFERENCE = new RegExp(`\\\\(?:${REFERENCE_COMMANDS})\\*?\\{([^}]*)$`);
const OPEN_INCLUDE = /\\(?:includegraphics|include|input)(?:\[[^\]]*\])?\{([^}]*)$/;
const COMPLETE_CITATION = new RegExp(`\\\\(?:${CITATION_COMMANDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)\\}`, "g");
const COMPLETE_REFERENCE = new RegExp(`\\\\(?:${REFERENCE_COMMANDS})\\*?\\{([^}]*)\\}`, "g");
const COMPLETE_INCLUDE = /\\(?:input|include)\{([^}]*)\}/g;
const COMPLETE_GRAPHICS = /\\includegraphics(?:\[[^\]]*\])?\{((?:\\detokenize\{[^}]*\}|[^}]+))\}/g;
const COMPLETE_LABEL = /\\label\{([^}]*)\}/g;
const GRAPHICSPATH = /\\graphicspath\s*\{((?:\{[^}]*\})+)\}/g;
const NEWCOMMAND = /\\(?:new|renew|provide)command\*?\{(\\[A-Za-z@]+)\}/g;
const NEWENVIRONMENT = /\\(?:new|renew)environment\*?\{([A-Za-z*][A-Za-z0-9*]*)\}/g;
const BEGIN_OR_END = /\\(begin|end)\{([A-Za-z*][A-Za-z0-9*]*)\}/g;
const CLOSED_BEGIN = /\\begin\{([A-Za-z*][A-Za-z0-9*]*)\}$/;

export type CitationInfo = {
  key: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
};

export type ReferenceInfo = {
  label: string;
  kind: "figure" | "table" | "equation" | "section" | "reference" | string;
  title: string;
  snippet: string;
  path: string;
  line: number;
  imagePath?: string;
};

export type DefinitionTarget =
  | { kind: "reference"; path: string; line: number; label: string }
  | { kind: "citation"; key: string }
  | { kind: "include"; path: string }
  | { kind: "asset"; path: string };

export type SymbolTarget =
  | { kind: "label"; label: string }
  | { kind: "citation"; key: string };

export const latexLanguageOptions = {
  enableAutocomplete: false,
  enableLinting: false,
  enableTooltips: true,
} as const;

export const luxLatexHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.definitionKeyword], color: "var(--syntax-keyword)", fontWeight: "600", fontStyle: "oblique" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  { tag: [tags.heading, tags.function(tags.variableName), tags.macroName], color: "var(--syntax-function)", fontWeight: "600" },
  { tag: [tags.typeName, tags.className], color: "var(--syntax-type)" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: [tags.special(tags.variableName), tags.labelName, tags.processingInstruction], color: "var(--syntax-variable-special)", fontStyle: "italic" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: tags.attributeName, color: "var(--syntax-attribute)" },
  { tag: [tags.string, tags.quote], color: "var(--syntax-string)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.docComment, tags.meta], color: "var(--syntax-comment-doc)", fontStyle: "italic" },
  { tag: tags.bool, color: "var(--syntax-number)", fontWeight: "600" },
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: tags.constant(tags.name), color: "var(--syntax-constant)" },
  { tag: tags.bracket, color: "var(--syntax-bracket)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "inherit", textDecoration: "none" },
]);

export function shouldInsertCommandBraces(textBeforeCursor: string): boolean {
  return BRACED_COMMANDS.test(textBeforeCursor);
}

export function beginEnvironmentClose(
  textBeforeCursor: string,
  textAfterCursor: string,
): { insert: string; cursorOffset: number } | null {
  const match = CLOSED_BEGIN.exec(textBeforeCursor);
  if (!match) return null;
  const name = match[1];
  const alreadyClosed = new RegExp(`^\\s*\\\\end\\{${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`);
  if (alreadyClosed.test(textAfterCursor)) return null;
  return { insert: `\n  \n\\end{${name}}`, cursorOffset: 3 };
}

export function countWords(text: string): number {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

export type TextStats = { words: number; chars: number; lines: number };

export function textStats(text: string): TextStats {
  if (!text) return { words: 0, chars: 0, lines: 0 };
  return {
    words: countWords(text),
    chars: text.length,
    lines: text.split("\n").length,
  };
}

function lineBounds(text: string, from: number, to: number): { from: number; to: number } {
  const start = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const endNewline = text.indexOf("\n", to);
  const end = endNewline === -1 ? text.length : endNewline;
  return { from: start, to: end };
}

export function sortSelectedLines(
  text: string,
  from: number,
  to: number,
): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const bounds = lineBounds(text, from, to);
  const block = text.slice(bounds.from, bounds.to);
  const lines = block.split("\n");
  if (lines.length < 2) return null;
  const sorted = [...lines].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  if (sorted.join("\n") === block) return null;
  return { from: bounds.from, to: bounds.to, insert: sorted.join("\n") };
}

export type CaseMode = "upper" | "lower" | "title";

export function transformCase(
  text: string,
  from: number,
  to: number,
  mode: CaseMode,
): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const selected = text.slice(from, to);
  const insert = mode === "upper"
    ? selected.toLocaleUpperCase()
    : mode === "lower"
      ? selected.toLocaleLowerCase()
      : selected.replace(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g, (word) =>
        word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase(),
      );
  if (insert === selected) return null;
  return { from, to, insert };
}

export function wrapRange(
  text: string,
  from: number,
  to: number,
  before: string,
  after: string,
): { from: number; to: number; insert: string; cursorFrom: number; cursorTo: number } {
  const selected = text.slice(from, to);
  const insert = `${before}${selected}${after}`;
  if (selected) {
    return {
      from,
      to,
      insert,
      cursorFrom: from + before.length,
      cursorTo: from + before.length + selected.length,
    };
  }
  return {
    from,
    to,
    insert,
    cursorFrom: from + before.length,
    cursorTo: from + before.length,
  };
}

export function wrapEnvironment(
  text: string,
  from: number,
  to: number,
  name: string,
): { from: number; to: number; insert: string; cursorFrom: number; cursorTo: number } {
  const env = name.trim() || "equation";
  const selected = text.slice(from, to);
  const before = `\\begin{${env}}\n`;
  const after = `\n\\end{${env}}`;
  if (selected) {
    const insert = `${before}${selected}${after}`;
    return {
      from,
      to,
      insert,
      cursorFrom: from + before.length,
      cursorTo: from + before.length + selected.length,
    };
  }
  const insert = `${before}  ${after}`;
  return {
    from,
    to,
    insert,
    cursorFrom: from + before.length + 2,
    cursorTo: from + before.length + 2,
  };
}

export type CommentWrapStyle = "comment-env" | "iffalse";

export function wrapCommentRegion(
  text: string,
  from: number,
  to: number,
  style: CommentWrapStyle,
): { from: number; to: number; insert: string; cursorFrom: number; cursorTo: number } {
  if (style === "comment-env") {
    return wrapEnvironment(text, from, to, "comment");
  }
  const selected = text.slice(from, to);
  const before = "\\iffalse\n";
  const after = "\n\\fi";
  if (selected) {
    const insert = `${before}${selected}${after}`;
    return {
      from,
      to,
      insert,
      cursorFrom: from + before.length,
      cursorTo: from + before.length + selected.length,
    };
  }
  const insert = `${before}  ${after}`;
  return {
    from,
    to,
    insert,
    cursorFrom: from + before.length + 2,
    cursorTo: from + before.length + 2,
  };
}

export function renameEnvironmentAt(
  text: string,
  position: number,
  newName: string,
): { from: number; to: number; insert: string }[] | null {
  const name = newName.trim();
  if (!name) return null;
  const current = environmentAt(text, position);
  if (current) {
    const match = matchingEnvironmentTarget(text, position);
    if (!match) return null;
    const openIsCurrent = current.kind === "begin";
    const begin = openIsCurrent ? { from: current.from, to: current.to } : match;
    const end = openIsCurrent ? match : { from: current.from, to: current.to };
    return [
      { from: begin.from, to: begin.to, insert: `\\begin{${name}}` },
      { from: end.from, to: end.to, insert: `\\end{${name}}` },
    ];
  }
  const enclosing = enclosingEnvironment(text, position);
  if (!enclosing) return null;
  return [
    { from: enclosing.beginFrom, to: enclosing.beginTo, insert: `\\begin{${name}}` },
    { from: enclosing.endFrom, to: enclosing.endTo, insert: `\\end{${name}}` },
  ];
}

/** Labels defined in a dirty buffer, for live completion before save. */
export function parseLocalLabels(path: string, source: string): ReferenceInfo[] {
  const labels: ReferenceInfo[] = [];
  const seen = new Set<string>();
  COMPLETE_LABEL.lastIndex = 0;
  for (let match = COMPLETE_LABEL.exec(source); match; match = COMPLETE_LABEL.exec(source)) {
    const label = match[1].trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const line = source.slice(0, match.index).split("\n").length;
    labels.push({
      label,
      kind: "reference",
      title: label,
      snippet: source.split("\n")[line - 1]?.trim() ?? "",
      path,
      line,
    });
  }
  return labels;
}

export function mergeReferences(
  projectReferences: ReferenceInfo[],
  activePath: string,
  localLabels: ReferenceInfo[],
): ReferenceInfo[] {
  const projectByLabel = new Map(
    projectReferences
      .filter((reference) => reference.path === activePath)
      .map((reference) => [reference.label, reference]),
  );
  const byLabel = new Map<string, ReferenceInfo>();
  for (const reference of projectReferences) {
    if (reference.path === activePath) continue;
    byLabel.set(reference.label, reference);
  }
  for (const local of localLabels) {
    const existing = projectByLabel.get(local.label);
    byLabel.set(local.label, existing ? {
      ...existing,
      line: local.line,
      snippet: local.snippet || existing.snippet,
      path: local.path,
    } : local);
  }
  return [...byLabel.values()];
}

export type LocalMacro = {
  label: string;
  detail: string;
  type: "keyword" | "type";
};

export function parseLocalMacros(sources: string[]): LocalMacro[] {
  const macros = new Map<string, LocalMacro>();
  for (const source of sources) {
    NEWCOMMAND.lastIndex = 0;
    for (let match = NEWCOMMAND.exec(source); match; match = NEWCOMMAND.exec(source)) {
      const label = match[1];
      if (!macros.has(label)) macros.set(label, { label, detail: "project command", type: "keyword" });
    }
    NEWENVIRONMENT.lastIndex = 0;
    for (let match = NEWENVIRONMENT.exec(source); match; match = NEWENVIRONMENT.exec(source)) {
      const name = match[1];
      const begin = `\\begin{${name}}`;
      if (!macros.has(begin)) {
        macros.set(begin, { label: begin, detail: "project environment", type: "type" });
      }
    }
  }
  return [...macros.values()];
}

export function unwrapLatexPath(raw: string): string {
  const trimmed = raw.trim();
  const detokenized = trimmed.match(/^\\detokenize\{([^}]*)\}?$/);
  return (detokenized ? detokenized[1] : trimmed).trim().replace(/\\/g, "/");
}

export function parseGraphicsPaths(sources: string[]): string[] {
  const roots = new Set<string>();
  for (const source of sources) {
    GRAPHICSPATH.lastIndex = 0;
    for (let match = GRAPHICSPATH.exec(source); match; match = GRAPHICSPATH.exec(source)) {
      for (const part of match[1].matchAll(/\{([^}]*)\}/g)) {
        const path = part[1].trim().replace(/\\/g, "/").replace(/\/+$/, "");
        if (path) roots.add(path);
      }
    }
  }
  return [...roots];
}

function normalizeGraphicsRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function resolveProjectPath(
  raw: string,
  projectPaths: string[],
  kind: "tex" | "graphics",
  graphicsRoots: string[] = [],
): string | null {
  const trimmed = unwrapLatexPath(raw);
  if (!trimmed || trimmed.startsWith("http:") || trimmed.startsWith("https:")) return trimmed || null;
  if (kind === "tex") {
    const candidates = trimmed.endsWith(".tex") ? [trimmed] : [trimmed, `${trimmed}.tex`];
    for (const candidate of candidates) {
      if (projectPaths.includes(candidate)) return candidate;
      const nested = projectPaths.find((path) => path === candidate || path.endsWith(`/${candidate}`));
      if (nested) return nested;
    }
    return null;
  }
  const extensions = ["", ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".webp"];
  const prefixes = [
    "",
    ...graphicsRoots.map((root) => `${normalizeGraphicsRoot(root)}/`),
  ];
  for (const prefix of prefixes) {
    for (const extension of extensions) {
      const base = trimmed.includes(".") ? trimmed : `${trimmed}${extension}`;
      const candidate = `${prefix}${base}`.replace(/\/+/g, "/");
      if (projectPaths.includes(candidate)) return candidate;
      const nested = projectPaths.find((path) => path === candidate || path.endsWith(`/${candidate}`));
      if (nested) return nested;
      if (trimmed.includes(".")) break;
    }
  }
  return null;
}

function missingIncludeCreatePath(raw: string): string | null {
  const trimmed = unwrapLatexPath(raw);
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("..") || trimmed.includes(":")) {
    return null;
  }
  return trimmed.endsWith(".tex") ? trimmed : `${trimmed}.tex`;
}

export function pathDiagnostics(
  text: string,
  projectPaths: string[],
  graphicsRoots: string[] = [],
  onCreateMissingFile?: (path: string) => void,
): Diagnostic[] {
  if (!projectPaths.length) return [];
  const diagnostics: Diagnostic[] = [];
  COMPLETE_INCLUDE.lastIndex = 0;
  for (let match = COMPLETE_INCLUDE.exec(text); match; match = COMPLETE_INCLUDE.exec(text)) {
    const path = match[1].trim();
    if (!path) continue;
    if (resolveProjectPath(path, projectPaths, "tex")) continue;
    const from = match.index + match[0].lastIndexOf("{") + 1;
    const createPath = missingIncludeCreatePath(path);
    diagnostics.push({
      from,
      to: from + match[1].length,
      severity: "warning",
      message: `Missing file “${path}”.`,
      source: "paths",
      actions: createPath && onCreateMissingFile
        ? [{
          name: "Create file",
          apply: () => {
            onCreateMissingFile(createPath);
          },
        }]
        : undefined,
    });
  }
  COMPLETE_GRAPHICS.lastIndex = 0;
  for (let match = COMPLETE_GRAPHICS.exec(text); match; match = COMPLETE_GRAPHICS.exec(text)) {
    const rawPath = match[1].trim();
    if (!rawPath) continue;
    if (resolveProjectPath(rawPath, projectPaths, "graphics", graphicsRoots)) continue;
    const path = unwrapLatexPath(rawPath);
    const from = match.index + match[0].indexOf("{") + 1;
    diagnostics.push({
      from,
      to: from + match[1].length,
      severity: "warning",
      message: `Missing figure “${path || rawPath}”.`,
      source: "paths",
    });
  }
  return diagnostics;
}

export function toggleLineComments(
  text: string,
  from: number,
  to: number,
): { from: number; to: number; insert: string; cursorFrom: number; cursorTo: number } {
  const start = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const anchor = to > from ? to - 1 : from;
  const lineEnd = text.indexOf("\n", anchor);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const block = text.slice(start, end);
  const lines = block.split("\n");
  const contentLines = lines.filter((line) => line.trim().length > 0);
  const uncomment = contentLines.length > 0 && contentLines.every((line) => /^\s*%/.test(line));
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    if (uncomment) return line.replace(/^(\s*)%\s?/, "$1");
    const indent = line.match(/^\s*/)?.[0] ?? "";
    return `${indent}% ${line.slice(indent.length)}`;
  }).join("\n");
  return {
    from: start,
    to: end,
    insert: next,
    cursorFrom: start,
    cursorTo: start + next.length,
  };
}

function environmentAt(text: string, position: number): { kind: "begin" | "end"; name: string; from: number; to: number } | null {
  BEGIN_OR_END.lastIndex = 0;
  for (let match = BEGIN_OR_END.exec(text); match; match = BEGIN_OR_END.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (position < from || position >= to) continue;
    return {
      kind: match[1] === "begin" ? "begin" : "end",
      name: match[2],
      from,
      to,
    };
  }
  return null;
}

type EnvironmentEvent = { kind: "begin" | "end"; name: string; from: number; to: number };

function environmentEvents(text: string): EnvironmentEvent[] {
  const events: EnvironmentEvent[] = [];
  BEGIN_OR_END.lastIndex = 0;
  for (let match = BEGIN_OR_END.exec(text); match; match = BEGIN_OR_END.exec(text)) {
    events.push({
      kind: match[1] === "begin" ? "begin" : "end",
      name: match[2],
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return events;
}

export type EnclosingEnvironment = {
  name: string;
  beginFrom: number;
  beginTo: number;
  endFrom: number;
  endTo: number;
};

/** Innermost \\begin/\\end pair that contains position (including the delimiters). */
export function enclosingEnvironment(text: string, position: number): EnclosingEnvironment | null {
  const events = environmentEvents(text);
  const stack: EnvironmentEvent[] = [];
  let best: EnclosingEnvironment | null = null;
  for (const event of events) {
    if (event.kind === "begin") {
      stack.push(event);
      continue;
    }
    const open = stack.pop();
    if (!open || open.name !== event.name) continue;
    // Innermost pairs close first while scanning left-to-right.
    if (!best && position >= open.from && position <= event.to) {
      best = {
        name: open.name,
        beginFrom: open.from,
        beginTo: open.to,
        endFrom: event.from,
        endTo: event.to,
      };
    }
  }
  return best;
}

export function enclosingEnvironmentRange(
  text: string,
  position: number,
): { from: number; to: number } | null {
  const env = enclosingEnvironment(text, position);
  if (!env) return null;
  return { from: env.beginFrom, to: env.endTo };
}

export function matchingEnvironmentTarget(text: string, position: number): { from: number; to: number } | null {
  const current = environmentAt(text, position);
  if (current) {
    const events = environmentEvents(text);
    if (current.kind === "begin") {
      let depth = 0;
      for (const event of events) {
        if (event.from < current.from) continue;
        if (event.name !== current.name) continue;
        if (event.kind === "begin") depth += 1;
        else {
          depth -= 1;
          if (depth === 0) return { from: event.from, to: event.to };
        }
      }
      return null;
    }
    let depth = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.to > current.to) continue;
      if (event.name !== current.name) continue;
      if (event.kind === "end") depth += 1;
      else {
        depth -= 1;
        if (depth === 0) return { from: event.from, to: event.to };
      }
    }
    return null;
  }
  const enclosing = enclosingEnvironment(text, position);
  if (!enclosing) return null;
  return { from: enclosing.beginFrom, to: enclosing.beginTo };
}

export function citationCompletionRange(textBeforeCursor: string, cursor: number): { from: number; query: string } | null {
  const match = OPEN_CITATION.exec(textBeforeCursor);
  if (!match) return null;
  const parts = match[1].split(",");
  const query = parts[parts.length - 1]?.trimStart() ?? "";
  return { from: cursor - query.length, query };
}

export function referenceCompletionRange(textBeforeCursor: string, cursor: number): { from: number; query: string } | null {
  const match = OPEN_REFERENCE.exec(textBeforeCursor);
  if (!match) return null;
  const parts = match[1].split(",");
  const query = parts[parts.length - 1]?.trimStart() ?? "";
  return { from: cursor - query.length, query };
}

export function includeCompletionRange(textBeforeCursor: string, cursor: number): { from: number; query: string } | null {
  const match = OPEN_INCLUDE.exec(textBeforeCursor);
  if (!match) return null;
  return { from: cursor - match[1].length, query: match[1] };
}

function citationCompletions(citations: CitationInfo[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const windowStart = Math.max(0, context.pos - 600);
    const before = context.state.sliceDoc(windowStart, context.pos);
    const range = citationCompletionRange(before, context.pos);
    if (!range) return null;
    const query = range.query.toLocaleLowerCase();
    return {
      from: range.from,
      options: citations
        .filter((citation) => !query || citation.key.toLocaleLowerCase().includes(query)
          || citation.title.toLocaleLowerCase().includes(query))
        .map((citation) => ({
          label: citation.key,
          type: "reference",
          // Keep the title inline so a side info panel cannot cover the key list.
          detail: citation.title
            || [citation.authors, citation.year].filter(Boolean).join(" · ")
            || undefined,
        })),
      validFor: /^[^,}\s]*$/,
    };
  };
}

function referenceCompletions(references: ReferenceInfo[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const windowStart = Math.max(0, context.pos - 600);
    const before = context.state.sliceDoc(windowStart, context.pos);
    const range = referenceCompletionRange(before, context.pos);
    if (!range) return null;
    const query = range.query.toLocaleLowerCase();
    return {
      from: range.from,
      options: references
        .filter((reference) => !query || reference.label.toLocaleLowerCase().includes(query)
          || reference.title.toLocaleLowerCase().includes(query))
        .map((reference) => ({
          label: reference.label,
          type: "variable",
          detail: reference.kind,
          info: reference.title || undefined,
        })),
      validFor: /^[^,}\s]*$/,
    };
  };
}

function includeCompletions(projectPaths: string[], graphicsRoots: string[] = []) {
  const files = projectPaths.filter((path) => path.endsWith(".tex") || /\.(png|jpe?g|pdf|svg|eps|webp)$/i.test(path));
  const roots = graphicsRoots.map(normalizeGraphicsRoot);
  return (context: CompletionContext): CompletionResult | null => {
    const windowStart = Math.max(0, context.pos - 600);
    const before = context.state.sliceDoc(windowStart, context.pos);
    const range = includeCompletionRange(before, context.pos);
    if (!range) return null;
    const query = range.query.toLocaleLowerCase();
    const graphics = before.includes("\\includegraphics");
    const labels = new Map<string, string>();
    for (const path of files) {
      if (graphics ? path.endsWith(".tex") : !path.endsWith(".tex")) continue;
      labels.set(path, graphics ? "figure" : "tex");
      if (!graphics) continue;
      for (const root of roots) {
        const prefix = `${root}/`;
        if (path.startsWith(prefix)) {
          labels.set(path.slice(prefix.length), "graphicspath");
        }
      }
    }
    return {
      from: range.from,
      options: [...labels.entries()]
        .filter(([path]) => !query || path.toLocaleLowerCase().includes(query))
        .map(([path, detail]) => ({
          label: path,
          type: "text",
          detail,
        })),
      validFor: /^[^}]*$/,
    };
  };
}

export function includeHoverTarget(text: string, position: number): { from: number; to: number; path: string } | null {
  COMPLETE_INCLUDE.lastIndex = 0;
  for (let match = COMPLETE_INCLUDE.exec(text); match; match = COMPLETE_INCLUDE.exec(text)) {
    const from = match.index + match[0].lastIndexOf("{") + 1;
    const path = match[1].trim();
    const to = from + match[1].length;
    if (!path || position < from || position > to) continue;
    return { from, to, path };
  }
  return null;
}

export function graphicsHoverTarget(text: string, position: number): { from: number; to: number; path: string } | null {
  COMPLETE_GRAPHICS.lastIndex = 0;
  for (let match = COMPLETE_GRAPHICS.exec(text); match; match = COMPLETE_GRAPHICS.exec(text)) {
    const from = match.index + match[0].indexOf("{") + 1;
    const rawPath = match[1].trim();
    const path = unwrapLatexPath(rawPath);
    const to = from + match[1].length;
    if (!path || position < from || position > to) continue;
    return { from, to, path };
  }
  return null;
}

export function labelHoverTarget(text: string, position: number): { from: number; to: number; label: string } | null {
  COMPLETE_LABEL.lastIndex = 0;
  for (let match = COMPLETE_LABEL.exec(text); match; match = COMPLETE_LABEL.exec(text)) {
    const from = match.index + match[0].lastIndexOf("{") + 1;
    const label = match[1].trim();
    const to = from + match[1].length;
    if (!label || position < from || position > to) continue;
    return { from, to, label };
  }
  return null;
}

export function symbolAt(text: string, position: number): SymbolTarget | null {
  const label = labelHoverTarget(text, position) ?? referenceHoverTarget(text, position);
  if (label && "label" in label) return { kind: "label", label: label.label };
  const citation = citationHoverTarget(text, position);
  if (citation) return { kind: "citation", key: citation.key };
  return null;
}

export function definitionTargetAt(
  text: string,
  position: number,
  references: ReferenceInfo[],
  projectPaths: string[] = [],
  graphicsRoots: string[] = [],
): DefinitionTarget | null {
  const reference = referenceHoverTarget(text, position) ?? labelHoverTarget(text, position);
  if (reference) {
    const info = references.find((item) => item.label === reference.label);
    if (info) return { kind: "reference", path: info.path, line: info.line, label: info.label };
  }
  const citation = citationHoverTarget(text, position);
  if (citation) return { kind: "citation", key: citation.key };
  const graphics = graphicsHoverTarget(text, position);
  if (graphics) {
    const resolved = resolveProjectPath(graphics.path, projectPaths, "graphics", graphicsRoots) ?? graphics.path;
    return { kind: "asset", path: resolved };
  }
  const include = includeHoverTarget(text, position);
  if (include) {
    const resolved = resolveProjectPath(include.path, projectPaths, "tex");
    const path = resolved ?? (include.path.endsWith(".tex") ? include.path : `${include.path}.tex`);
    return { kind: "include", path };
  }
  return null;
}

export function bibliographyEntryLine(source: string, key: string): number | null {
  const pattern = new RegExp(`@[A-Za-z]+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`, "i");
  const match = pattern.exec(source);
  if (!match) return null;
  return source.slice(0, match.index).split("\n").length;
}

function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let inMath = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === "$" && line[index - 1] !== "\\") {
          inMath = !inMath;
          continue;
        }
        if (!inMath && character === "%" && line[index - 1] !== "\\") {
          return `${line.slice(0, index)}${" ".repeat(line.length - index)}`;
        }
      }
      return line;
    })
    .join("\n");
}

export function structureDiagnostics(text: string): Diagnostic[] {
  const source = stripLineComments(text);
  const diagnostics: Diagnostic[] = [];
  const stack: { name: string; from: number; to: number }[] = [];
  const labels = new Map<string, number>();
  BEGIN_OR_END.lastIndex = 0;
  for (let match = BEGIN_OR_END.exec(source); match; match = BEGIN_OR_END.exec(source)) {
    const kind = match[1];
    const name = match[2];
    const from = match.index;
    const to = from + match[0].length;
    if (kind === "begin") {
      stack.push({ name, from, to });
      continue;
    }
    const open = stack.pop();
    if (!open) {
      diagnostics.push({
        from,
        to,
        severity: "error",
        message: `Unmatched \\end{${name}}.`,
        source: "structure",
      });
      continue;
    }
    if (open.name !== name) {
      diagnostics.push({
        from,
        to,
        severity: "error",
        message: `Expected \\end{${open.name}}, found \\end{${name}}.`,
        source: "structure",
      });
    }
  }
  for (const open of stack) {
    diagnostics.push({
      from: open.from,
      to: open.to,
      severity: "error",
      message: `Unclosed \\begin{${open.name}}.`,
      source: "structure",
    });
  }
  COMPLETE_LABEL.lastIndex = 0;
  for (let match = COMPLETE_LABEL.exec(source); match; match = COMPLETE_LABEL.exec(source)) {
    const label = match[1].trim();
    if (!label) continue;
    const from = match.index + match[0].lastIndexOf("{") + 1;
    const to = from + match[1].length;
    const previous = labels.get(label);
    if (previous != null) {
      diagnostics.push({
        from,
        to,
        severity: "warning",
        message: `Duplicate label “${label}”.`,
        source: "labels",
      });
    } else {
      labels.set(label, from);
    }
  }
  const bibKeys = new Map<string, number>();
  const BIB_ENTRY = /@\w+\s*\{\s*([^,\s}]+)/g;
  for (let match = BIB_ENTRY.exec(source); match; match = BIB_ENTRY.exec(source)) {
    const key = match[1].trim();
    if (!key) continue;
    const from = match.index + match[0].length - key.length;
    const to = from + key.length;
    const previous = bibKeys.get(key);
    if (previous != null) {
      diagnostics.push({
        from,
        to,
        severity: "warning",
        message: `Duplicate bibliography key “${key}”.`,
        source: "bibliography",
      });
    } else {
      bibKeys.set(key, from);
    }
  }
  for (const diagnostic of unclosedMathDiagnostics(source)) {
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

export function indexDiagnostics(
  text: string,
  citationKeys: string[],
  references: ReferenceInfo[],
  unusedLabels: string[] = [],
  unusedCitations: string[] = [],
  projectPaths: string[] = [],
  currentPath = "",
  graphicsRoots: string[] = [],
  onCreateMissingFile?: (path: string) => void,
): Diagnostic[] {
  const keys = new Set(citationKeys);
  const labels = new Set(references.map((reference) => reference.label));
  const unusedLabelSet = new Set(unusedLabels);
  const unusedCitationSet = new Set(unusedCitations);
  const duplicateLabelPaths = new Map<string, string[]>();
  for (const reference of references) {
    const paths = duplicateLabelPaths.get(reference.label) ?? [];
    if (!paths.includes(reference.path)) paths.push(reference.path);
    duplicateLabelPaths.set(reference.label, paths);
  }
  const diagnostics: Diagnostic[] = [
    ...structureDiagnostics(text),
    ...pathDiagnostics(text, projectPaths, graphicsRoots, onCreateMissingFile),
  ];
  COMPLETE_CITATION.lastIndex = 0;
  for (let match = COMPLETE_CITATION.exec(text); match; match = COMPLETE_CITATION.exec(text)) {
    const contentFrom = match.index + match[0].lastIndexOf("{") + 1;
    for (const keyMatch of match[1].matchAll(/[^,]+/g)) {
      const raw = keyMatch[0];
      const leading = raw.length - raw.trimStart().length;
      const key = raw.trim();
      if (!key || keys.has(key)) continue;
      const from = contentFrom + (keyMatch.index ?? 0) + leading;
      diagnostics.push({
        from,
        to: from + key.length,
        severity: "warning",
        message: `Unknown citation key “${key}”.`,
        source: "bibliography",
      });
    }
  }
  COMPLETE_REFERENCE.lastIndex = 0;
  for (let match = COMPLETE_REFERENCE.exec(text); match; match = COMPLETE_REFERENCE.exec(text)) {
    const contentFrom = match.index + match[0].lastIndexOf("{") + 1;
    for (const labelMatch of match[1].matchAll(/[^,]+/g)) {
      const raw = labelMatch[0];
      const leading = raw.length - raw.trimStart().length;
      const label = raw.trim();
      if (!label || labels.has(label)) continue;
      const from = contentFrom + (labelMatch.index ?? 0) + leading;
      diagnostics.push({
        from,
        to: from + label.length,
        severity: "warning",
        message: `Unknown label “${label}”.`,
        source: "labels",
      });
    }
  }
  COMPLETE_LABEL.lastIndex = 0;
  for (let match = COMPLETE_LABEL.exec(text); match; match = COMPLETE_LABEL.exec(text)) {
    const label = match[1].trim();
    if (!label) continue;
    const from = match.index + match[0].lastIndexOf("{") + 1;
    const to = from + match[1].length;
    const paths = duplicateLabelPaths.get(label) ?? [];
    const otherPaths = currentPath
      ? paths.filter((path) => path !== currentPath)
      : [];
    if (otherPaths.length) {
      diagnostics.push({
        from,
        to,
        severity: "warning",
        message: `Duplicate label “${label}” also defined in ${otherPaths[0]}${otherPaths.length > 1 ? ` (+${otherPaths.length - 1} more)` : ""}.`,
        source: "labels",
      });
    } else if (unusedLabelSet.has(label)) {
      diagnostics.push({
        from,
        to,
        severity: "warning",
        message: `Unused label “${label}”.`,
        source: "labels",
      });
    }
  }
  const bibKey = /@([A-Za-z]+)\s*\{\s*([^,\s}]+)/g;
  for (let match = bibKey.exec(text); match; match = bibKey.exec(text)) {
    const key = match[2].trim();
    if (!key || !unusedCitationSet.has(key)) continue;
    const from = match.index + match[0].lastIndexOf(key);
    diagnostics.push({
      from,
      to: from + key.length,
      severity: "warning",
      message: `Unused citation key “${key}”.`,
      source: "bibliography",
    });
  }
  return diagnostics;
}

export function citationHoverTarget(text: string, position: number): { from: number; to: number; key: string } | null {
  const windowStart = Math.max(0, position - 800);
  const windowEnd = Math.min(text.length, position + 800);
  const source = text.slice(windowStart, windowEnd);
  COMPLETE_CITATION.lastIndex = 0;
  for (let match = COMPLETE_CITATION.exec(source); match; match = COMPLETE_CITATION.exec(source)) {
    const citationFrom = windowStart + match.index;
    const citationTo = citationFrom + match[0].length;
    if (position < citationFrom || position > citationTo) continue;
    const content = match[1];
    const contentFrom = citationFrom + match[0].lastIndexOf("{") + 1;
    const keys: { from: number; to: number; key: string }[] = [];
    for (const keyMatch of content.matchAll(/[^,]+/g)) {
      const raw = keyMatch[0];
      const leading = raw.length - raw.trimStart().length;
      const key = raw.trim();
      if (!key) continue;
      const from = contentFrom + (keyMatch.index ?? 0) + leading;
      keys.push({ from, to: from + key.length, key });
    }
    const hovered = keys.find((key) => position >= key.from && position <= key.to);
    if (hovered) return hovered;
    if (keys.length === 1) return keys[0];
  }
  return null;
}

export function referenceHoverTarget(text: string, position: number): { from: number; to: number; label: string } | null {
  const windowStart = Math.max(0, position - 800);
  const windowEnd = Math.min(text.length, position + 800);
  const source = text.slice(windowStart, windowEnd);
  COMPLETE_REFERENCE.lastIndex = 0;
  for (let match = COMPLETE_REFERENCE.exec(source); match; match = COMPLETE_REFERENCE.exec(source)) {
    const referenceFrom = windowStart + match.index;
    const referenceTo = referenceFrom + match[0].length;
    if (position < referenceFrom || position > referenceTo) continue;
    const content = match[1];
    const contentFrom = referenceFrom + match[0].lastIndexOf("{") + 1;
    const labels = [...content.matchAll(/[^,]+/g)].flatMap((labelMatch) => {
      const raw = labelMatch[0];
      const leading = raw.length - raw.trimStart().length;
      const label = raw.trim();
      if (!label) return [];
      const from = contentFrom + (labelMatch.index ?? 0) + leading;
      return [{ from, to: from + label.length, label }];
    });
    const hovered = labels.find((label) => position >= label.from && position <= label.to);
    if (hovered) return hovered;
    if (labels.length === 1) return labels[0];
  }
  return null;
}

export function citationTooltipSpace(bounds: Rect): Rect {
  const inset = 8;
  return {
    left: bounds.left + inset,
    right: bounds.right - inset,
    top: bounds.top + inset,
    bottom: bounds.bottom - inset,
  };
}

function citationTooltips(citations: CitationInfo[]) {
  const byKey = new Map(citations.map((citation) => [citation.key, citation]));
  return hoverTooltip((view, position) => {
    const target = citationHoverTarget(view.state.doc.toString(), position);
    if (!target) return null;
    const citation = byKey.get(target.key);
    if (!citation) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "citation-hover-card";
        dom.style.maxWidth = `${Math.max(160, view.dom.clientWidth - 16)}px`;
        const key = document.createElement("small");
        key.textContent = citation.key;
        const title = document.createElement("strong");
        title.textContent = citation.title || citation.key;
        dom.append(key, title);
        if (citation.authors) {
          const authors = document.createElement("span");
          authors.textContent = citation.authors.replace(/ and /g, " · ");
          dom.append(authors);
        }
        const publication = [citation.venue, citation.year].filter(Boolean).join(" · ");
        if (publication) {
          const detail = document.createElement("em");
          detail.textContent = publication;
          dom.append(detail);
        }
        return { dom };
      },
    };
  });
}

function referenceTooltips(
  references: ReferenceInfo[],
  loadImage?: (path: string) => Promise<string | null>,
) {
  const byLabel = new Map(references.map((reference) => [reference.label, reference]));
  return hoverTooltip((view, position) => {
    const target = referenceHoverTarget(view.state.doc.toString(), position);
    if (!target) return null;
    const reference = byLabel.get(target.label);
    if (!reference) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        let destroyed = false;
        const dom = document.createElement("div");
        dom.className = "reference-hover-card";
        dom.style.maxWidth = `${Math.max(180, view.dom.clientWidth - 16)}px`;
        if (reference.imagePath && loadImage) {
          const media = document.createElement("div");
          media.className = "reference-hover-media loading";
          media.textContent = "Loading figure preview…";
          dom.append(media);
          void loadImage(reference.imagePath).then((source) => {
            if (destroyed) return;
            media.classList.remove("loading");
            if (!source) {
              media.textContent = "Preview unavailable for this figure format.";
              return;
            }
            const image = document.createElement("img");
            image.src = source;
            image.alt = reference.title || reference.label;
            media.replaceChildren(image);
          }).catch(() => {
            if (!destroyed) {
              media.classList.remove("loading");
              media.textContent = "Figure preview could not be loaded.";
            }
          });
        }
        const label = document.createElement("small");
        label.textContent = `${reference.kind} · ${reference.label}`;
        const title = document.createElement("strong");
        title.textContent = reference.title || reference.label;
        dom.append(label, title);
        if (reference.snippet) {
          const snippet = document.createElement("pre");
          snippet.textContent = reference.snippet;
          dom.append(snippet);
        }
        const path = document.createElement("em");
        path.textContent = reference.path;
        dom.append(path);
        return {
          dom,
          destroy() {
            destroyed = true;
          },
        };
      },
    };
  });
}

function wrapSelectionCommand(before: string, after: string) {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    const edit = wrapRange(view.state.doc.toString(), range.from, range.to, before, after);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: edit.cursorFrom === edit.cursorTo
        ? { anchor: edit.cursorFrom }
        : { anchor: edit.cursorFrom, head: edit.cursorTo },
      scrollIntoView: true,
    });
    return true;
  };
}

function wrapEnvironmentCommand(name: string) {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    const edit = wrapEnvironment(view.state.doc.toString(), range.from, range.to, name);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: edit.cursorFrom === edit.cursorTo
        ? { anchor: edit.cursorFrom }
        : { anchor: edit.cursorFrom, head: edit.cursorTo },
      scrollIntoView: true,
    });
    return true;
  };
}

function applyTextEdit(
  view: EditorView,
  edit: { from: number; to: number; insert: string } | null,
): boolean {
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.from, head: edit.from + edit.insert.length },
    scrollIntoView: true,
  });
  return true;
}

function sortLinesCommand(view: EditorView): boolean {
  const range = view.state.selection.main;
  return applyTextEdit(view, sortSelectedLines(view.state.doc.toString(), range.from, range.to));
}

function caseCommand(mode: CaseMode) {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    return applyTextEdit(view, transformCase(view.state.doc.toString(), range.from, range.to, mode));
  };
}

function commentWrapCommand(style: CommentWrapStyle) {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    const edit = wrapCommentRegion(view.state.doc.toString(), range.from, range.to, style);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: edit.cursorFrom === edit.cursorTo
        ? { anchor: edit.cursorFrom }
        : { anchor: edit.cursorFrom, head: edit.cursorTo },
      scrollIntoView: true,
    });
    return true;
  };
}

function lineCommentCommand(view: EditorView): boolean {
  const range = view.state.selection.main;
  const edit = toggleLineComments(view.state.doc.toString(), range.from, range.to);
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.cursorFrom, head: edit.cursorTo },
    scrollIntoView: true,
  });
  return true;
}

function dollarPairCommand(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return wrapSelectionCommand("$", "$")(view);
  }
  const before = view.state.sliceDoc(Math.max(0, range.head - 1), range.head);
  const after = view.state.sliceDoc(range.head, range.head + 1);
  if (before === "$" && after === "$") {
    view.dispatch({
      changes: { from: range.head - 1, to: range.head + 1, insert: "$$$$" },
      selection: { anchor: range.head + 1 },
      scrollIntoView: true,
    });
    return true;
  }
  if (after === "$") {
    view.dispatch({
      selection: { anchor: range.head + 1 },
      scrollIntoView: true,
    });
    return true;
  }
  view.dispatch({
    changes: { from: range.head, insert: "$$" },
    selection: { anchor: range.head + 1 },
    scrollIntoView: true,
  });
  return true;
}

export type LatexEditorLiveData = {
  citationKeys: string[];
  citations: CitationInfo[];
  references: ReferenceInfo[];
  unusedLabels: string[];
  unusedCitations: string[];
  localMacros: LocalMacro[];
  graphicsRoots: string[];
  projectPaths: string[];
};

/**
 * CodeMirror paints the selection layer *behind* line content. A filled
 * `.cm-activeLine` background therefore hides local selection on the current
 * line. Toggle a class so CSS can clear that fill while a range is selected.
 */
export function selectionVisibilityExtension(): Extension {
  const CLASS = "cm-lattice-has-selection";
  const sync = (view: EditorView) => {
    view.dom.classList.toggle(CLASS, !view.state.selection.main.empty);
  };
  return [
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) sync(update.view);
    }),
    EditorView.domEventHandlers({
      // Ensure the class is correct on first focus / mount.
      focus: (_event, view) => {
        sync(view);
        return false;
      },
    }),
  ];
}

export function latexEditorExtensions(
  citationKeys: string[],
  citations: CitationInfo[] = [],
  references: ReferenceInfo[] = [],
  loadReferenceImage?: (path: string) => Promise<string | null>,
  onGotoDefinition?: (target: DefinitionTarget) => void,
  projectPaths: string[] = [],
  onFindReferences?: (target: SymbolTarget) => void,
  onRenameSymbol?: (target: SymbolTarget) => void,
  spellcheck = false,
  unusedLabels: string[] = [],
  unusedCitations: string[] = [],
  onRenameEnvironment?: (currentName: string) => void,
  onWrapEnvironment?: () => void,
  localMacros: LocalMacro[] = [],
  currentPath = "",
  onPasteImage?: (file: File) => boolean | void,
  graphicsRoots: string[] = [],
  onCreateMissingFile?: (path: string) => void,
  enableTexlabLanguage = false,
  onTexlabGoto?: (path: string, line: number, column?: number) => void,
  liveRef?: { current: LatexEditorLiveData },
) {
  const live = (): LatexEditorLiveData => liveRef?.current ?? {
    citationKeys,
    citations,
    references,
    unusedLabels,
    unusedCitations,
    localMacros,
    graphicsRoots,
    projectPaths,
  };
  const citationSource = () => {
    const data = live();
    return data.citations.length
      ? data.citations
      : data.citationKeys.map((key) => ({ key, title: "", authors: "", year: "", venue: "" }));
  };
  const texlabPath = () => currentPath;
  const tryTexlabDefinition = (view: EditorView) => {
    if (!enableTexlabLanguage || !onTexlabGoto || !currentPath.endsWith(".tex")) return false;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    void resolveTexlabDefinition(
      currentPath,
      view.state.doc.toString(),
      line.number,
      head - line.from + 1,
    ).then((location) => {
      if (location) onTexlabGoto(location.path, location.line, location.column);
    });
    return true;
  };
  const macroCompletions = (context: CompletionContext): CompletionResult | null => {
    const { localMacros: macros } = live();
    if (!macros.length) return null;
    const word = context.matchBefore(/\\[A-Za-z@]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const query = word.text.toLocaleLowerCase();
    const options = macros
      .filter((macro) => macro.label.toLocaleLowerCase().includes(query))
      .map((macro) => ({
        label: macro.label,
        type: macro.type,
        detail: macro.detail,
      }));
    if (!options.length) return null;
    return { from: word.from, options, validFor: /^\\?[A-Za-z@]*$/ };
  };
  return [
    EditorView.lineWrapping,
    selectionVisibilityExtension(),
    EditorView.contentAttributes.of({
      spellcheck: spellcheck ? "true" : "false",
      autocorrect: spellcheck ? "on" : "off",
      autocapitalize: "off",
    }),
    syntaxHighlighting(luxLatexHighlightStyle),
    search({ top: true }),
    highlightSelectionMatches(),
    tooltips({
      tooltipSpace: (view) => citationTooltipSpace(view.dom.getBoundingClientRect()),
    }),
    citationTooltips(citations),
    referenceTooltips(references, loadReferenceImage),
    ...(enableTexlabLanguage ? [texlabHoverTooltip(texlabPath)] : []),
    linter((view) => {
      const data = live();
      return indexDiagnostics(
        view.state.doc.toString(),
        data.citationKeys,
        data.references,
        data.unusedLabels,
        data.unusedCitations,
        data.projectPaths,
        currentPath,
        data.graphicsRoots,
        onCreateMissingFile,
      );
    }, {
      delay: 400,
    }),
    autocompletion({
      override: [
        (context) => citationCompletions(citationSource())(context),
        (context) => referenceCompletions(live().references)(context),
        (context) => includeCompletions(live().projectPaths, live().graphicsRoots)(context),
        macroCompletions,
        ...(enableTexlabLanguage ? [texlabCompletionSource(texlabPath)] : []),
        latexCompletionSource(true),
      ],
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      icons: false,
    }),
    EditorView.domEventHandlers({
      click(event, view) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position == null) return false;
        const data = live();
        const target = onGotoDefinition
          ? definitionTargetAt(
            view.state.doc.toString(),
            position,
            data.references,
            data.projectPaths,
            data.graphicsRoots,
          )
          : null;
        if (target && onGotoDefinition) {
          event.preventDefault();
          onGotoDefinition(target);
          return true;
        }
        if (enableTexlabLanguage && onTexlabGoto && currentPath.endsWith(".tex")) {
          event.preventDefault();
          const line = view.state.doc.lineAt(position);
          void resolveTexlabDefinition(
            currentPath,
            view.state.doc.toString(),
            line.number,
            position - line.from + 1,
          ).then((location) => {
            if (location) onTexlabGoto(location.path, location.line, location.column);
          });
          return true;
        }
        return false;
      },
      paste(event) {
        if (!onPasteImage || !event.clipboardData) return false;
        const items = [...event.clipboardData.items];
        const imageItem = items.find((item) => item.type.startsWith("image/"));
        if (!imageItem) return false;
        const file = imageItem.getAsFile();
        if (!file) return false;
        const handled = onPasteImage(file);
        if (handled === false) return false;
        event.preventDefault();
        return true;
      },
    }),
    keymap.of([
      ...searchKeymap,
      { key: "Mod-f", run: openSearchPanel },
      { key: "Mod-Alt-a", run: replaceAll },
      { key: "Mod-/", run: lineCommentCommand },
      { key: "Mod-b", run: wrapSelectionCommand("\\textbf{", "}") },
      { key: "Mod-i", run: wrapSelectionCommand("\\emph{", "}") },
      { key: "Mod-Shift-m", run: wrapSelectionCommand("$", "$") },
      { key: "Mod-Alt-e", run: wrapEnvironmentCommand("equation") },
      { key: "Mod-Alt-i", run: wrapEnvironmentCommand("itemize") },
      { key: "Mod-Alt-s", run: sortLinesCommand },
      { key: "Mod-Alt-u", run: caseCommand("upper") },
      { key: "Mod-Alt-l", run: caseCommand("lower") },
      { key: "Mod-Alt-c", run: caseCommand("title") },
      { key: "Mod-Alt-/", run: commentWrapCommand("comment-env") },
      { key: "Mod-Alt-;", run: commentWrapCommand("iffalse") },
      {
        key: "Mod-Alt-w",
        run: () => {
          if (!onWrapEnvironment) return false;
          onWrapEnvironment();
          return true;
        },
      },
      {
        key: "F12",
        run: (view) => {
          if (onGotoDefinition) {
            const data = live();
            const target = definitionTargetAt(
              view.state.doc.toString(),
              view.state.selection.main.head,
              data.references,
              data.projectPaths,
              data.graphicsRoots,
            );
            if (target) {
              onGotoDefinition(target);
              return true;
            }
          }
          return tryTexlabDefinition(view);
        },
      },
      {
        key: "Shift-F12",
        run: (view) => {
          if (!onFindReferences) return false;
          const target = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
          if (!target) return false;
          onFindReferences(target);
          return true;
        },
      },
      {
        key: "F2",
        run: (view) => {
          if (!onRenameSymbol) return false;
          const target = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
          if (!target) return false;
          onRenameSymbol(target);
          return true;
        },
      },
      {
        key: "Ctrl-m",
        mac: "Ctrl-m",
        run: (view) => {
          const text = view.state.doc.toString();
          const head = view.state.selection.main.head;
          const target = matchingEnvironmentTarget(text, head)
            ?? matchingMathDelimiter(text, head);
          if (!target) return false;
          view.dispatch({
            selection: { anchor: target.from, head: target.to },
            scrollIntoView: true,
          });
          return true;
        },
      },
      {
        key: "Mod-Alt-a",
        run: (view) => {
          const range = enclosingEnvironmentRange(
            view.state.doc.toString(),
            view.state.selection.main.head,
          );
          if (!range) return false;
          view.dispatch({
            selection: { anchor: range.from, head: range.to },
            scrollIntoView: true,
          });
          return true;
        },
      },
      {
        key: "Mod-Alt-r",
        run: (view) => {
          if (!onRenameEnvironment) return false;
          const text = view.state.doc.toString();
          const head = view.state.selection.main.head;
          const current = environmentAt(text, head);
          if (current) {
            onRenameEnvironment(current.name);
            return true;
          }
          const enclosing = enclosingEnvironment(text, head);
          if (!enclosing) return false;
          onRenameEnvironment(enclosing.name);
          return true;
        },
      },
    ]),
    // Lowest precedence so Vim's `$` (end of line) still wins when that keymap is active.
    Prec.lowest(keymap.of([{ key: "$", run: dollarPairCommand }])),
    EditorView.updateListener.of((update) => {
      const insertedCommand = update.transactions.some((transaction) =>
        transaction.isUserEvent("input.type") || transaction.isUserEvent("input.complete"),
      );
      if (!update.docChanged || !insertedCommand) return;
      const selection = update.state.selection.main;
      if (!selection.empty) return;
      const before = update.state.sliceDoc(Math.max(0, selection.head - 120), selection.head);
      const after = update.state.sliceDoc(selection.head, Math.min(update.state.doc.length, selection.head + 80));
      const close = beginEnvironmentClose(before, after);
      if (close) {
        update.view.dispatch({
          changes: { from: selection.head, insert: close.insert },
          selection: { anchor: selection.head + close.cursorOffset },
          annotations: Transaction.userEvent.of("input.type"),
        });
        return;
      }
      if (update.state.sliceDoc(selection.head, selection.head + 1) === "{") return;
      if (!shouldInsertCommandBraces(before)) return;
      update.view.dispatch({
        changes: { from: selection.head, insert: "{}" },
        selection: { anchor: selection.head + 1 },
        annotations: Transaction.userEvent.of("input.type"),
      });
    }),
  ];
}
