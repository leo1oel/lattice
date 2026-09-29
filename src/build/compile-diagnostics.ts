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

export function normalizeDiagnosticPath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const normalized = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) return undefined;
  const lower = normalized.toLocaleLowerCase();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- project directory names
  const markers = ["/src/", "/chapters/", "/sections/", "/figures/"];
  for (const marker of markers) {
    const index = lower.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (absolute) {
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  return normalized;
}

export function diagnosticMatchesFile(diagnosticFile: string | undefined, activeFile: string): boolean {
  const diagnostic = normalizeDiagnosticPath(diagnosticFile);
  const active = normalizeDiagnosticPath(activeFile);
  if (!diagnostic || !active) return false;
  if (diagnostic === active) return true;
  return diagnostic.endsWith(`/${active}`) || active.endsWith(`/${diagnostic}`);
}

type ProjectPathNode = { path: string; children?: ProjectPathNode[] };

/** Every path in the project tree, parents before their children. */
export function flattenProjectPaths(nodes: ProjectPathNode[]): string[] {
  return nodes.flatMap((node) => [...(node.path ? [node.path] : []), ...flattenProjectPaths(node.children ?? [])]);
}

export function resolveDiagnosticPath(diagnosticFile: string | undefined, projectFiles: string[], fallbackPath = ""): string {
  const normalized = normalizeDiagnosticPath(diagnosticFile);
  if (!normalized) return fallbackPath;
  const slashed = (path: string) => path.replace(/\\/g, "/");
  return projectFiles.find((path) => slashed(path) === normalized)
    ?? projectFiles.find((path) => slashed(path).endsWith(normalized))
    ?? normalized;
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

export function summarizeDiagnostics(diagnostics: CompileDiagnostic[]) {
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
