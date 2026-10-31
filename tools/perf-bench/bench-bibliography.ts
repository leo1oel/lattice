/**
 * The bench's reads of the project's bibliography, as the backend's citation
 * commands report them: the `.bib` entries, where the `.tex` files cite them,
 * and the citation audit's scan.
 */
import { NOT_HANDLED } from "./bench-overleaf";

type ProjectFiles = Map<string, string | Uint8Array>;
type Context = {
  params: URLSearchParams;
  files: ProjectFiles;
  /** The project's `.bib` entries reach `list_citations`: the tutorial and a `?bibEntries=` project do; the fixture cites nothing. */
  cited: boolean;
};

/** The answer to a bibliography command, or `NOT_HANDLED` for any other. */
export function bibliographyAnswer(command: string, { files, cited }: Context): unknown {
  switch (command) {
    case "bibliography_audit_scan":
      return bibliographyAuditScan(files);
    case "list_citation_usages":
      return citationUsages(files);
    case "list_citations":
      return cited ? bibliographyCitations(files) : [];
    default:
      return NOT_HANDLED;
  }
}

/** Every `\\cite…{keys}` in the project's .tex files, as `list_citation_usages` reports them. */
function citationUsages(files: ProjectFiles) {
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
function bibliographyCitations(files: ProjectFiles) {
  const field = (entry: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`, "i")
    .exec(entry)?.[1].replace(/[{}]/g, "").replace(/\s+/g, " ").trim() ?? "";
  return [...files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string" ? content.split(/\n(?=@)/) : []
  )).flatMap((entry) => {
    const key = /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(entry)?.[1];
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
function bibliographyAuditScan(files: ProjectFiles) {
  const entries = [...files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string"
      ? content.split(/\n(?=@)/).flatMap((bibtex) => {
        const key = /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(bibtex)?.[1];
        const title = /\btitle\s*=\s*\{([^}]*)\}/i.exec(bibtex)?.[1] ?? "";
        return key ? [{ path, key, title, bibtex: bibtex.trim(), issues: [] }] : [];
      })
      : []
  ));
  const coverage = [...files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string" ? [{ path, kind: "bibliography", entries: entries.filter((entry) => entry.path === path).length }] : []
  ));
  return { entries, issues: [], coverage };
}
