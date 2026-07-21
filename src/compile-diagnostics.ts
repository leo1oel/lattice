import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";

export type CompileDiagnostic = {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  level: string;
  message: string;
};

export type DiagnosticSeverity = "error" | "warning" | "info";

export function diagnosticSeverity(level: string): DiagnosticSeverity {
  const normalized = level.trim().toLocaleLowerCase();
  if (normalized === "error" || normalized === "fatal") return "error";
  if (normalized === "warning" || normalized === "warn") return "warning";
  return "info";
}

export function normalizeDiagnosticPath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const normalized = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) return undefined;
  const lower = normalized.toLocaleLowerCase();
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

export function flattenProjectPaths(nodes: { path: string; children?: { path: string; children?: unknown[] }[] }[]): string[] {
  const paths: string[] = [];
  const visit = (items: { path: string; children?: { path: string; children?: unknown[] }[] }[]) => {
    for (const node of items) {
      if (node.path) paths.push(node.path);
      if (node.children?.length) visit(node.children as { path: string; children?: { path: string; children?: unknown[] }[] }[]);
    }
  };
  visit(nodes);
  return paths;
}

export function resolveDiagnosticPath(
  diagnosticFile: string | undefined,
  projectFiles: string[],
  fallbackPath = "",
): string {
  const normalized = normalizeDiagnosticPath(diagnosticFile);
  if (!normalized) return fallbackPath;
  const exact = projectFiles.find((path) => path.replace(/\\/g, "/") === normalized);
  if (exact) return exact;
  const suffix = projectFiles.find((path) => {
    const candidate = path.replace(/\\/g, "/");
    return candidate.endsWith(`/${normalized}`) || candidate.endsWith(normalized);
  });
  return suffix ?? normalized;
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

export function summarizeDiagnostics(diagnostics: CompileDiagnostic[]) {
  return diagnostics.reduce(
    (summary, diagnostic) => {
      const severity = diagnosticSeverity(diagnostic.level);
      summary[severity] += 1;
      return summary;
    },
    { error: 0, warning: 0, info: 0 },
  );
}

export function editorDiagnosticsForFile(
  diagnostics: CompileDiagnostic[],
  activeFile: string,
  doc: Text,
): CmDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnosticMatchesFile(diagnostic.file, activeFile)) return [];
    const lineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), Math.max(doc.lines, 1));
    const line = doc.line(lineNumber);
    return [{
      from: line.from,
      to: line.to,
      severity: diagnosticSeverity(diagnostic.level),
      message: diagnostic.message,
      source: "latexmk",
    }];
  });
}

export function diagnosticLocationLabel(diagnostic: CompileDiagnostic): string {
  const file = normalizeDiagnosticPath(diagnostic.file);
  if (file && diagnostic.line) return `${file}:${diagnostic.line}`;
  if (file) return file;
  if (diagnostic.line) return `line ${diagnostic.line}`;
  return "Build log";
}
