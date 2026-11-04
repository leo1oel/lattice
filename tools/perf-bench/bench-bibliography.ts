/**
 * The bench's reads of the project's bibliography, as the backend's citation
 * commands report them: the `.bib` entries, where the `.tex` files cite them
 * and the citation audit's scan (mock-backend/bibliography.ts), the files a
 * staged index leaves out, and the lookup that resolves a pasted reference
 * (bench-citation-lookup.ts).
 */
import { citationLookupAnswer } from "./bench-citation-lookup";
import { bibliographyAuditScan, bibliographyCitations, citationUsages } from "../mock-backend/bibliography";
import { NOT_HANDLED } from "../mock-backend/tauri-internals";

type Args = Record<string, unknown> | undefined;
type ProjectFiles = Map<string, string | Uint8Array>;
type Context = {
  params: URLSearchParams;
  files: ProjectFiles;
  /** The project's `.bib` entries reach `list_citations`: the tutorial and a `?bibEntries=` project do; the fixture cites nothing. */
  cited: boolean;
};

/**
 * `?index=skipped`: the label scan leaves out a GBK draft and a file it could
 * not read, as `list_references` names them; `?index=failed` fails the
 * citation scan. Either shows the label and citation index's toast.
 */
const STAGED_SKIPPED_SOURCES = [
  { path: "archive/old-draft.tex", reason: "notUtf8" },
  { path: "legacy/refs-latin1.tex", reason: "notUtf8" },
  { path: "locked.tex", reason: "unreadable", message: "Permission denied (os error 13)" },
];

/** The answer to a bibliography command, or `NOT_HANDLED` for any other. */
export function bibliographyAnswer(command: string, args: Args, { params, files, cited }: Context): unknown {
  switch (command) {
    case "resolve_citation_query":
      return citationLookupAnswer(args, params);
    case "bibliography_audit_scan":
      return bibliographyAuditScan(files);
    case "list_citation_usages":
      return citationUsages(files);
    case "list_citations":
      if (params.get("index") === "failed") throw "Permission denied (os error 13)";
      return { citations: cited ? bibliographyCitations(files) : [], skipped: [] };
    case "list_references":
      return { references: [], skipped: params.get("index") === "skipped" ? STAGED_SKIPPED_SOURCES : [] };
    default:
      return NOT_HANDLED;
  }
}
