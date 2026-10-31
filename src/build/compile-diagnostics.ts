import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { compileDiagnosticText } from "./build-log-messages";

export type CompileDiagnostic = {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  level: string;
  message: string;
  /** Lattice's own advice as a code the interface translates (build-log-messages.ts). */
  code?: string;
  params?: Record<string, string>;
};

export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * The one referentially stable "nothing to report" shared by App and the shell
 * layout: a fresh `[]` per render rebuilds the editor's lint pass.
 */
export const EMPTY_DIAGNOSTICS: CompileDiagnostic[] = [];

const MISSING_TEX_DEPENDENCY = /^Missing LaTeX (?:package|dependency) `([^`]+\.(?:sty|cls|bst|bbx|cbx))`\./i;

/** A TeX file the local distribution can try to resolve through `tlmgr`. */
export function missingTexDependencyFile(message: string): string | null {
  return MISSING_TEX_DEPENDENCY.exec(message.trim())?.[1] ?? null;
}

const SEVERITIES = new Map<string, DiagnosticSeverity>([
  ["error", "error"], ["fatal", "error"], ["warning", "warning"], ["warn", "warning"],
]);

export function diagnosticSeverity(level: string): DiagnosticSeverity {
  return SEVERITIES.get(level.trim().toLocaleLowerCase()) ?? "info";
}

/** `file` with forward slashes and no `.` or empty segments: `./a//./b.tex` is `a/b.tex`. */
function cleanDiagnosticPath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const parts = file.replace(/\\/g, "/").split("/");
  return parts.filter((part, index) => part !== "." && (part !== "" || index === 0)).join("/") || undefined;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

/**
 * The name a diagnostic's file is shown and grouped under. The build names a
 * project file by its exact path from the project root (diagnostic_paths.rs),
 * shown whole: `arxiv/` and `paper/` copies of `sections/intro.tex` are two
 * files. Only a path TeX gave in full, outside the project or not, is cut to
 * its last project-like folder, else its name.
 */
export function normalizeDiagnosticPath(file: string | undefined): string | undefined {
  const cleaned = cleanDiagnosticPath(file);
  if (!cleaned || !isAbsolutePath(cleaned)) return cleaned;
  const lower = cleaned.toLocaleLowerCase();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- project directory names
  const markers = ["/src/", "/chapters/", "/sections/", "/figures/"];
  for (const marker of markers) {
    const index = lower.lastIndexOf(marker);
    if (index >= 0) return cleaned.slice(index + 1);
  }
  const parts = cleaned.split("/").filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

/**
 * Whether a diagnostic belongs to the project file `activeFile`: by its exact
 * path, never by a shared name, so an error in `paper/sections/intro.tex`
 * leaves `arxiv/sections/intro.tex` alone. A path TeX gave in full can only
 * end with the file's: nothing here knows the project's own folder.
 */
export function diagnosticMatchesFile(diagnosticFile: string | undefined, activeFile: string): boolean {
  const diagnostic = cleanDiagnosticPath(diagnosticFile);
  const active = cleanDiagnosticPath(activeFile);
  if (!diagnostic || !active) return false;
  return diagnostic === active || (isAbsolutePath(diagnostic) && diagnostic.endsWith(`/${active}`));
}

type ProjectPathNode = { path: string; children?: ProjectPathNode[] };

/** Every path in the project tree, parents before their children. */
export function flattenProjectPaths(nodes: ProjectPathNode[]): string[] {
  return nodes.flatMap((node) => [...(node.path ? [node.path] : []), ...flattenProjectPaths(node.children ?? [])]);
}

/**
 * The project file a diagnostic names: the one at its exact path. Failing
 * that, a full path TeX gave that ends with a project file's path, or a
 * shorter one a project file's path ends with, picks that file, but only when
 * exactly one file fits; with several, guessing opened the wrong copy. A
 * suffix counts at a folder boundary only: `intro.tex` is not `preintro.tex`.
 */
export function resolveDiagnosticPath(diagnosticFile: string | undefined, projectFiles: string[], fallbackPath = ""): string {
  const path = cleanDiagnosticPath(diagnosticFile);
  if (!path) return fallbackPath;
  const exact = projectFiles.find((file) => cleanDiagnosticPath(file) === path);
  if (exact) return exact;
  const absolute = isAbsolutePath(path);
  const candidates = projectFiles.filter((file) => {
    const cleaned = cleanDiagnosticPath(file);
    if (!cleaned) return false;
    return absolute ? path.endsWith(`/${cleaned}`) : cleaned.endsWith(`/${path}`);
  });
  return candidates.length === 1 ? candidates[0]! : normalizeDiagnosticPath(path)!;
}

export function sortDiagnostics(diagnostics: CompileDiagnostic[]): CompileDiagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...diagnostics].sort((left, right) => {
    const severity = rank[diagnosticSeverity(left.level)] - rank[diagnosticSeverity(right.level)];
    if (severity !== 0) return severity;
    const leftFile = normalizeDiagnosticPath(left.file) ?? "";
    const rightFile = normalizeDiagnosticPath(right.file) ?? "";
    if (leftFile !== rightFile) return leftFile.localeCompare(rightFile);
    return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  });
}

export type DiagnosticFileGroup = { file: string | undefined; diagnostics: CompileDiagnostic[] };

/**
 * Sorted diagnostics gathered under their file, so twenty warnings from one
 * chapter read as one place to visit. Groups and their messages keep the
 * sorted order, so a file with an error still comes first and leads with it.
 */
export function groupDiagnosticsByFile(sorted: readonly CompileDiagnostic[]): DiagnosticFileGroup[] {
  const groups = new Map<string, DiagnosticFileGroup>();
  for (const diagnostic of sorted) {
    const file = normalizeDiagnosticPath(diagnostic.file);
    const group = groups.get(file ?? "");
    if (group) group.diagnostics.push(diagnostic);
    else groups.set(file ?? "", { file, diagnostics: [diagnostic] });
  }
  return [...groups.values()];
}

/**
 * Identity of a set of diagnostics, for "has this changed since you dismissed
 * it?": autosave recompiles on every pause in typing, and a warning the writer
 * dismissed must stay dismissed across those rebuilds. Order is not identity:
 * latexmk can emit the same set in a different sequence between passes.
 *
 * The separators are control characters no diagnostic can contain, written as
 * escapes on purpose: the raw bytes make git treat this file as binary.
 */
export function diagnosticsFingerprint(diagnostics: CompileDiagnostic[]): string {
  return sortDiagnostics(diagnostics)
    .map((diagnostic) => [
      diagnostic.level,
      normalizeDiagnosticPath(diagnostic.file) ?? "",
      diagnostic.line ?? "",
      diagnostic.message,
    ].join("\u0000"))
    .join("\u0001");
}

/** How many diagnostics a build reported at each severity. */
export type DiagnosticCounts = Record<DiagnosticSeverity, number>;

export function summarizeDiagnostics(diagnostics: readonly CompileDiagnostic[]): DiagnosticCounts {
  const summary = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) summary[diagnosticSeverity(diagnostic.level)] += 1;
  return summary;
}

export function editorDiagnosticsForFile(diagnostics: CompileDiagnostic[], activeFile: string, doc: Text): CmDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnosticMatchesFile(diagnostic.file, activeFile)) return [];
    const lineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), Math.max(doc.lines, 1));
    const line = doc.line(lineNumber);
    const severity = diagnosticSeverity(diagnostic.level);
    return [{ from: line.from, to: line.to, severity, message: compileDiagnosticText(diagnostic), source: "latexmk" }];
  });
}

export function diagnosticLocationLabel(diagnostic: CompileDiagnostic): string {
  const file = normalizeDiagnosticPath(diagnostic.file);
  if (file && diagnostic.line) return `${file}:${diagnostic.line}`;
  if (file) return file;
  const line = diagnostic.line;
  if (line) return i18n._(msg`line ${line}`);
  return i18n._(msg`Build log`);
}

/**
 * Where a failed build's log should open: TeX's first error, else the first
 * LaTeX or package error, else the end, where latexmk says why it stopped.
 * Builds run with -file-line-error, so most errors read `./main.tex:4: …`;
 * one raised before TeX knows its line (a missing package) keeps `! …`.
 */
export function failedLogAnchor(log: string): number {
  const error = /^(?:! |[^\s:][^:\n]*:\d+: )/m.exec(log) ?? /^.*\b(?:LaTeX|Package \S+) Error\b/m.exec(log);
  return error ? error.index : log.length;
}

/** Where `token` stands on `text`; a command only where it ends (`\cite` is not the start of `\citep`). */
export function tokenOffset(text: string, token: string): number {
  let at = text.indexOf(token);
  if (!/^\\[A-Za-z@]+$/.test(token)) return at;
  while (at >= 0 && /[A-Za-z@]/.test(text[at + token.length] ?? "")) at = text.indexOf(token, at + 1);
  return at;
}

/** The replacement a suggestion makes on `line` of `text`, or null when the token is no longer there. */
export function replaceTokenOnLine(text: string, line: number, token: string, replacement: string): { from: number; to: number; insert: string } | null {
  const lines = text.split("\n");
  if (line < 1 || line > lines.length) return null;
  const at = tokenOffset(lines[line - 1]!, token);
  if (at < 0) return null;
  const from = lines.slice(0, line - 1).reduce((offset, previous) => offset + previous.length + 1, 0) + at;
  return { from, to: from + token.length, insert: replacement };
}
