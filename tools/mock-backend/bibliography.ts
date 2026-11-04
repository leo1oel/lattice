/**
 * The project's indexes as the backend's scans report them, read from the
 * files in memory: the `.bib` entries (`list_citations`), where the `.tex`
 * files cite them (`list_citation_usages`), the citation audit's scan, and
 * the labels a `\ref` can name (`list_references`).
 */
import type { ProjectFiles } from "./project";

const bibEntries = (files: ProjectFiles) => [...files].flatMap(([path, content]) => (
  path.endsWith(".bib") && typeof content === "string" ? content.split(/\n(?=@)/).map((bibtex) => ({ path, bibtex })) : []
));
const entryKey = (bibtex: string) => /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(bibtex)?.[1];

/** Every `\\cite…{keys}` in the project's .tex files, as `list_citation_usages` reports them. */
export function citationUsages(files: ProjectFiles) {
  const usages: Array<{ kind: string; symbol: string; role: string; path: string; line: number; snippet: string }> = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".tex") || typeof content !== "string") continue;
    const lines = content.split("\n");
    lines.forEach((text, index) => {
      for (const match of text.matchAll(/\\(?:no)?cite[a-z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
        for (const key of match[1].split(",").map((part) => part.trim()).filter(Boolean)) {
          usages.push({ kind: "citation", symbol: key, role: "reference", path, line: index + 1, snippet: text.trim().slice(0, 160) });
        }
      }
    });
  }
  return usages;
}

/**
 * The project's references as `list_citations` reports them (fields without
 * their braces), so a `\\cite` there has its card.
 */
export function bibliographyCitations(files: ProjectFiles) {
  const field = (entry: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`, "i")
    .exec(entry)?.[1].replace(/[{}]/g, "").replace(/\s+/g, " ").trim() ?? "";
  return bibEntries(files).flatMap(({ bibtex: entry }) => {
    const key = entryKey(entry);
    if (!key) return [];
    const arxivId = field(entry, "eprint");
    const doi = field(entry, "doi");
    return [{
      key, title: field(entry, "title"), authors: field(entry, "author"), year: field(entry, "year"),
      venue: field(entry, "journal") || field(entry, "booktitle") || (arxivId ? "arXiv" : ""),
      ...arxivId ? { arxivId } : {}, ...doi ? { doi } : {},
    }];
  });
}

/** `bibliography_audit_scan` over the project's `.bib` files, as the backend reads them. */
export function bibliographyAuditScan(files: ProjectFiles) {
  const entries = bibEntries(files).flatMap(({ path, bibtex }) => {
    const key = entryKey(bibtex);
    const title = /\btitle\s*=\s*\{([^}]*)\}/i.exec(bibtex)?.[1] ?? "";
    return key ? [{ path, key, title, bibtex: bibtex.trim(), issues: [] }] : [];
  });
  const coverage = [...files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string" ? [{ path, kind: "bibliography", entries: entries.filter((entry) => entry.path === path).length }] : []
  ));
  return { entries, issues: [], coverage };
}

const LABELLED = /\\(section|subsection|subsubsection|chapter)\*?\{([^}]*)\}|\\begin\{(figure|table|equation|align)\*?\}|\\caption\{([^}]*)\}|\\label\{([^}]+)\}/g;

/**
 * Every `\\label` in the project's .tex files, as `list_references` reports
 * them: its kind from the heading or environment it sits in, and that
 * heading's or caption's text as its title.
 */
export function labelReferences(files: ProjectFiles) {
  const references: Array<{ label: string; kind: string; title: string; snippet: string; path: string; line: number }> = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".tex") || typeof content !== "string") continue;
    const lines = content.split("\n");
    let kind = "reference";
    let title = "";
    lines.forEach((text, index) => {
      for (const [, heading, headingTitle, environment, caption, label] of text.matchAll(LABELLED)) {
        if (heading) [kind, title] = ["section", headingTitle ?? ""];
        else if (environment) [kind, title] = [environment === "align" ? "equation" : environment, ""];
        else if (caption) title = caption;
        else if (label) references.push({ label, kind, title, snippet: text.trim().slice(0, 160), path, line: index + 1 });
      }
    });
  }
  return references;
}
