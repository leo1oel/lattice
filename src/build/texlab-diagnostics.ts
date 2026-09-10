import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import {
  diagnosticMatchesFile,
  diagnosticSeverity,
  type CompileDiagnostic,
} from "./compile-diagnostics";

export type TexlabDiagnostic = CompileDiagnostic;

function clampOffset(lineFrom: number, lineLength: number, column: number | undefined, fallback: number): number {
  if (column == null || !Number.isFinite(column)) return lineFrom + fallback;
  const zeroBased = Math.max(0, Math.floor(column) - 1);
  return lineFrom + Math.min(zeroBased, lineLength);
}

export function editorTexlabDiagnosticsForFile(
  diagnostics: TexlabDiagnostic[],
  activeFile: string,
  doc: Text,
): CmDiagnostic[] {
  if (!doc.lines) return [];
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnosticMatchesFile(diagnostic.file, activeFile)) return [];
    // TexLab can attach box warnings from generated files (e.g. main.bbl)
    // to the root document with an empty range at its origin. That is not a
    // source location: keep the diagnostic data, but don't underline the
    // documentclass command. Other diagnostics at the origin can be real errors.
    if (
      diagnostic.line === 1 && diagnostic.column === 1 &&
      diagnostic.endLine === 1 && diagnostic.endColumn === 1 &&
      /^(?:Under|Over)full \\[hv]box\b/.test(diagnostic.message)
    ) return [];
    const startLineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), doc.lines);
    const endLineNumber = Math.min(Math.max(diagnostic.endLine ?? startLineNumber, 1), doc.lines);
    const startLine = doc.line(startLineNumber);
    const endLine = doc.line(endLineNumber);
    const from = clampOffset(startLine.from, startLine.length, diagnostic.column, 0);
    let to = clampOffset(
      endLine.from,
      endLine.length,
      diagnostic.endColumn,
      endLine.length,
    );
    if (to <= from) {
      to = Math.min(startLine.to, from + Math.max(1, Math.min(12, startLine.to - from)));
    }
    if (to <= from) {
      to = startLine.to;
      if (to <= from) return [];
    }
    return [{
      from,
      to,
      severity: diagnosticSeverity(diagnostic.level),
      message: diagnostic.message,
      source: "texlab",
    }];
  });
}
