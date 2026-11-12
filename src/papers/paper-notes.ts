/**
 * A paper's notes: one Markdown file per paper in the project, under
 * `notes/`, named by its citation key. The Paper reader's Add to note appends
 * a quote with its source link there, so the note leads back to the page it
 * came from. The file is an ordinary project document the writer can edit,
 * link and share like any other.
 */
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary } from "../app-types";
import { requestProjectTreeRefresh } from "../project/project-files-changed";
import { paperLinkHref } from "./paper-link";
import { markdownLinkText } from "./paper-source";

type NotedPaper = Pick<PaperSummary, "arxivId" | "citationKey" | "title" | "hasFullText">;

/** `notes/<citation key>.md`, or the library id for a paper the bibliography does not key. */
export function paperNotePath(paper: Pick<PaperSummary, "arxivId" | "citationKey">): string {
  const name = (paper.citationKey?.trim() || paper.arxivId).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|-+$/g, "");
  return `notes/${name || "paper"}.md`;
}

/**
 * The note after adding `entry`: appended after a blank line, or, for a note
 * not yet written, below the paper's title linking to the paper itself.
 */
export function withPaperNoteEntry(current: string | null, paper: NotedPaper, entry: string): string {
  if (current === null) {
    const title = markdownLinkText(paper.title.trim() || paper.arxivId);
    const href = paperLinkHref(paperNotePath(paper), paper);
    return `# ${title}\n\n[${title}](${href})\n\n${entry}\n`;
  }
  const kept = current.trimEnd();
  return kept ? `${kept}\n\n${entry}\n` : `${entry}\n`;
}

/**
 * Rewrite `paper`'s note in the project at `projectRoot` as `change` gives it
 * from what is there now (null for a note not yet written); `change` answers
 * null to leave it as it is. Resolves the note's path.
 */
export async function updatePaperNote(
  projectRoot: string, paper: Pick<PaperSummary, "arxivId" | "citationKey">, change: (current: string | null) => string | null,
): Promise<string> {
  const path = paperNotePath(paper);
  const { exists } = await invoke<{ exists: boolean }>("stat_project_file", { path });
  const current = exists ? await invoke<string>("read_project_file", { path, projectRoot }) : null;
  const content = change(current);
  if (content === null) return path;
  // The text read is the base: an edit that lands meanwhile is merged, not overwritten.
  await invoke("write_project_file", { path, projectRoot, content, ...(current === null ? {} : { baseContent: current }) });
  if (!exists) requestProjectTreeRefresh();
  return path;
}

/** Append `entry` to `paper`'s note in the project at `projectRoot`, writing the note if it is new; resolves its path. */
export function addToPaperNote(projectRoot: string, paper: NotedPaper, entry: string): Promise<string> {
  return updatePaperNote(projectRoot, paper, (current) => withPaperNoteEntry(current, paper, entry));
}
