const COMPLETE_LABEL = /\\label\{([^}]*)\}/g;
const GRAPHICSPATH = /\\graphicspath\s*\{((?:\{[^}]*\})+)\}/g;
const NEWCOMMAND = /\\(?:new|renew|provide)command\*?\{(\\[A-Za-z@]+)\}/g;
const NEWENVIRONMENT = /\\(?:new|renew)environment\*?\{([A-Za-z*][A-Za-z0-9*]*)\}/g;

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

export type LocalMacro = {
  label: string;
  detail: string;
  type: "keyword" | "type";
};

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

export function bibliographyEntryLine(source: string, key: string): number | null {
  const pattern = new RegExp(`@[A-Za-z]+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`, "i");
  const match = pattern.exec(source);
  if (!match) return null;
  return source.slice(0, match.index).split("\n").length;
}
