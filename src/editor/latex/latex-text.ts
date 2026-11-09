import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";
import { escapeRegExp } from "../../lib/escape-regexp";

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

/** Lower case, one UTF-16 unit for one, so a folded path keeps the original's offsets. */
export function foldCase(path: string): string {
  return path.replace(/[^]/g, (unit) => {
    const lower = unit.toLowerCase();
    return lower.length === 1 ? lower : unit;
  });
}

const foldedPaths = new WeakMap<readonly string[], string[]>();

/**
 * `projectPaths` folded by `foldCase`. The index hands every lint run the
 * same array, so it is folded once, not once per unresolved argument.
 */
function foldedProjectPaths(projectPaths: readonly string[]): string[] {
  let folded = foldedPaths.get(projectPaths);
  if (!folded) foldedPaths.set(projectPaths, folded = projectPaths.map(foldCase));
  return folded;
}

/** `path` with `.` and `..` collapsed; null when `..` climbs out of the project folder. */
export function normalizeProjectPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join("/");
}

/** The folder holding the root document, with its trailing `/`; empty at the top. */
export function rootFolder(rootPath: string): string {
  return rootPath.slice(0, rootPath.lastIndexOf("/") + 1);
}

/**
 * The project file a path names where TeX (latexmk `-cd`) reads it: the root
 * document's folder, whichever file holds the command. That is the only
 * place a `..` path can mean. `ignoreCase` matches as macOS's disk does.
 */
function inRootFolder(candidate: string, projectPaths: readonly string[], rootPath: string, ignoreCase: boolean) {
  const path = normalizeProjectPath(`${rootFolder(rootPath)}${candidate}`);
  if (!path) return null;
  const index = (ignoreCase ? foldedProjectPaths(projectPaths) : projectPaths).indexOf(ignoreCase ? foldCase(path) : path);
  return index < 0 ? null : projectPaths[index];
}

/**
 * A leniency for a file TeX would not find: the path read from the project
 * folder, else the one project file that ends with it. A copy in `arxiv-v1/`
 * must not stand in for the one the build reads, so when several end with
 * it, none is chosen. A written `.` or `..` pins the folder, so such a path
 * gets no leniency.
 */
function elsewhere(candidate: string, projectPaths: readonly string[], ignoreCase: boolean) {
  const fromProject = normalizeProjectPath(candidate);
  if (!fromProject || candidate.split("/").some((part) => part === "." || part === "..")) return null;
  const paths = ignoreCase ? foldedProjectPaths(projectPaths) : projectPaths;
  const wanted = ignoreCase ? foldCase(fromProject) : fromProject;
  const inProject = paths.indexOf(wanted);
  if (inProject >= 0) return projectPaths[inProject];
  let found = -1;
  for (const [index, path] of paths.entries()) {
    if (!path.endsWith(`/${wanted}`)) continue;
    if (found >= 0) return null;
    found = index;
  }
  return found < 0 ? null : projectPaths[found];
}

/**
 * The first of `candidates` (a path with each extension or search folder
 * TeX tries, in TeX's order) found in the root document's folder; only when
 * none is there, the first found by `elsewhere`. So a file TeX would not
 * read never wins over one it would.
 */
export function findPathCandidate<T extends { candidate: string }>(
  candidates: readonly T[],
  projectPaths: readonly string[],
  rootPath = "",
  ignoreCase = false,
): (T & { file: string }) | null {
  // An absolute path names a file on disk, never one in the project.
  const relative = candidates.filter((item) => !item.candidate.startsWith("/"));
  for (const item of relative) {
    const file = inRootFolder(item.candidate, projectPaths, rootPath, ignoreCase);
    if (file) return { ...item, file };
  }
  for (const item of relative) {
    const file = elsewhere(item.candidate, projectPaths, ignoreCase);
    if (file) return { ...item, file };
  }
  return null;
}

/** The project `.tex` file an `\input`/`\include` argument names, read from the root document `rootPath`. */
export function resolveTexPath(raw: string, projectPaths: string[], rootPath = ""): string | null {
  const path = raw.trim();
  if (!path) return null;
  const candidates = (path.endsWith(".tex") ? [path] : [path, `${path}.tex`]).map((candidate) => ({ candidate }));
  return findPathCandidate(candidates, projectPaths, rootPath)?.file ?? null;
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

