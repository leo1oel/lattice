import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";

export const LABEL = /\\label\{([^}]*)\}/g;
const GRAPHICSPATH = /\\graphicspath\s*\{((?:\{[^}]*\})+)\}/g;
const NEWCOMMAND = /\\(?:new|renew|provide)command\*?\{(\\[A-Za-z@]+)\}/g;
const NEWENVIRONMENT = /\\(?:new|renew)environment\*?\{([A-Za-z*][A-Za-z0-9*]*)\}/g;
const COMMAND_DEFINITION =
  /\\(?:new|renew|provide)command\*?\{(\\[A-Za-z@]+)\}(?:\s*\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

export type CitationInfo = {
  key: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi?: string;
  url?: string;
  arxivId?: string;
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

const REFERENCE_KINDS: Record<string, MessageDescriptor> = {
  figure: msg`figure`,
  table: msg`table`,
  equation: msg`equation`,
  section: msg`section`,
  reference: msg`reference`,
};

/** The reference kind as shown in completions and hover cards; `kind` itself stays an identifier. */
export function referenceKindLabel(kind: string): string {
  const label = REFERENCE_KINDS[kind];
  return label ? i18n._(label) : kind;
}

export type DefinitionTarget =
  | { kind: "reference"; path: string; line: number; label: string }
  | { kind: "citation"; key: string }
  | { kind: "include"; path: string }
  | { kind: "asset"; path: string };

export type SymbolTarget =
  | { kind: "label"; label: string }
  | { kind: "citation"; key: string };

export type LocalMacro = {
  label: string;
  detail: string;
  type: "keyword" | "type";
};

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Maps ascending offsets to 1-based lines in one pass over the source, so
 * callers never split the whole buffer per match (they run per keystroke).
 */
export function lineCounter(source: string): (offset: number) => number {
  let line = 1;
  let newline = source.indexOf("\n");
  return (offset) => {
    while (newline !== -1 && newline < offset) {
      line += 1;
      newline = source.indexOf("\n", newline + 1);
    }
    return line;
  };
}

/** `candidate` itself, or the project file that ends with it as a path suffix. */
export function findProjectPath(candidate: string, projectPaths: string[]): string | null {
  if (projectPaths.includes(candidate)) return candidate;
  return projectPaths.find((path) => path.endsWith(`/${candidate}`)) ?? null;
}

/** The project `.tex` file an `\input`/`\include` argument names. */
export function resolveTexPath(raw: string, projectPaths: string[]): string | null {
  const path = raw.trim();
  if (!path) return null;
  for (const candidate of path.endsWith(".tex") ? [path] : [path, `${path}.tex`]) {
    const found = findProjectPath(candidate, projectPaths);
    if (found) return found;
  }
  return null;
}

/** Labels defined in a dirty buffer, for live completion before save. */
export function parseLocalLabels(path: string, source: string): ReferenceInfo[] {
  const labels: ReferenceInfo[] = [];
  const seen = new Set<string>();
  const lineAt = lineCounter(source);
  for (const match of source.matchAll(LABEL)) {
    const label = match[1].trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const lineEnd = source.indexOf("\n", match.index);
    labels.push({
      label,
      kind: "reference",
      title: label,
      snippet: source.slice(source.lastIndexOf("\n", match.index) + 1, lineEnd === -1 ? undefined : lineEnd).trim(),
      path,
      line: lineAt(match.index),
    });
  }
  return labels;
}

export function mergeReferences(
  projectReferences: ReferenceInfo[],
  activePath: string,
  localLabels: ReferenceInfo[],
): ReferenceInfo[] {
  const activeByLabel = new Map<string, ReferenceInfo>();
  const byLabel = new Map<string, ReferenceInfo>();
  for (const reference of projectReferences) {
    (reference.path === activePath ? activeByLabel : byLabel).set(reference.label, reference);
  }
  for (const local of localLabels) {
    const existing = activeByLabel.get(local.label);
    byLabel.set(local.label, existing
      ? { ...existing, line: local.line, snippet: local.snippet || existing.snippet, path: local.path }
      : local);
  }
  return [...byLabel.values()];
}

export function parseLocalMacros(sources: string[]): LocalMacro[] {
  const macros = new Map<string, LocalMacro>();
  const add = (label: string, detail: string, type: LocalMacro["type"]) => {
    if (!macros.has(label)) macros.set(label, { label, detail, type });
  };
  for (const source of sources) {
    for (const [, name] of source.matchAll(NEWCOMMAND)) add(name, i18n._(msg`project command`), "keyword");
    for (const [, name] of source.matchAll(NEWENVIRONMENT)) add(`\\begin{${name}}`, i18n._(msg`project environment`), "type");
  }
  return [...macros.values()];
}

export function parseGraphicsPaths(sources: string[]): string[] {
  const roots = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(GRAPHICSPATH)) {
      for (const part of match[1].matchAll(/\{([^}]*)\}/g)) {
        const path = part[1].trim().replace(/\\/g, "/").replace(/\/+$/, "");
        if (path) roots.add(path);
      }
    }
  }
  return [...roots];
}

export function bibliographyEntryLine(source: string, key: string): number | null {
  const match = new RegExp(`@[A-Za-z]+\\s*\\{\\s*${escapeRegExp(key)}\\s*,`, "i").exec(source);
  return match ? source.slice(0, match.index).split("\n").length : null;
}

/** `\newcommand{\foo}{body}` definitions for KaTeX `macros`; the first definition wins. */
export function katexMacrosFromSources(sources: string[]): Record<string, string> {
  const macros: Record<string, string> = {};
  for (const source of sources) {
    for (const [, name, rawBody] of source.matchAll(COMMAND_DEFINITION)) {
      const body = rawBody.trim();
      if (name && body && !macros[name]) macros[name] = body;
    }
  }
  return macros;
}

/** Locate the first `\appendix` switch in project sources (line is 1-based). */
export function findAppendixMarker(sources: Record<string, string>): { path: string; line: number } | null {
  for (const [path, source] of Object.entries(sources)) {
    const index = source.split("\n").findIndex((line) => /(^|[^\\])\\appendix\b/.test(` ${line.split("%")[0]}`));
    if (index >= 0) return { path, line: index + 1 };
  }
  return null;
}
