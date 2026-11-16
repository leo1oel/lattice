/**
 * What the Tauri app's canvas gives a `.tex` editor's citation cards beyond
 * the bibliography (`use-document-surfaces.tsx`'s `bibliography`), built
 * from what the owner sends (`editor_panel/latex_visual_citations.rs`):
 *
 * - the library (`tex:library`): its papers by citation key, for a card's
 *   authors and Crossref badge; the keys Open paper is offered for, as the
 *   owner's Papers panel decides it (`papers/citation_open.rs`); and the
 *   revision of the manuscript's citation scan, after which a card counts
 *   its uses again (`citation-card-uses.ts` reads `list_citation_usages`
 *   once per revision);
 * - the project's citation reasons (`tex:reasons`), for a card's rows and
 *   the Why cited popover, and who files a new one.
 *
 * What the cards ask goes to the owner: Open paper (`tex:open-paper`), a
 * reason saved or removed (`tex:save-reason`, `tex:delete-reason`), and a
 * row's jump (`md:open-location`, as a `\ref`'s is). A reason's anchor is
 * not saved again from here (`onReanchorCitationReasons`): the page's
 * edits land in the owner's buffer, which writes back its reasons after
 * every edit, the page's among them, as the source does.
 */
import type { PaperSummary } from "../../../src/app-types";
import type { EditorComment } from "../../../src/editor/comments/editor-comment-data";
import type { LatexEditorLiveData } from "../../../src/editor/latex/latex-editor";
import { host } from "../shared/host";

export type CitationLibrary = {
  /** The library's papers that carry a citation key, with the fields a card reads. */
  papers: PaperSummary[];
  /** The citation keys Open paper is offered for. */
  openable: string[];
  /** Bumped by every scan of the manuscript's citations. */
  revision: number;
};

export type CitationReasons = {
  /** The project's citation reasons, on every file. */
  reasons: EditorComment[];
  /** Who files a new reason. */
  author: { id: string; name: string };
};

export const NO_LIBRARY: CitationLibrary = { papers: [], openable: [], revision: 0 };
export const NO_REASONS: CitationReasons = { reasons: [], author: { id: "", name: "" } };

const openPaper = (key: string, page?: number) => host().post("tex:open-paper", { key, page: page ?? null });
const saveReason = (reason: EditorComment) => host().post("tex:save-reason", { reason });
const deleteReason = (id: string) => host().post("tex:delete-reason", { id });
const openUse = (path: string, line: number) => host().post("md:open-location", { path, line });

/** The live data's citation fields, from the library and the reasons as the owner last sent them. */
export function citationLiveData(library: CitationLibrary, reasons: CitationReasons): Partial<LatexEditorLiveData> {
  // Citation keys match whatever their letter case, as everywhere else.
  const openable = new Set(library.openable.map((key) => key.toLocaleLowerCase()));
  return {
    papers: library.papers,
    canOpenCitation: (key) => openable.has(key.toLocaleLowerCase()),
    onOpenCitation: openPaper,
    citationUsageRevision: library.revision,
    citationReasons: reasons.reasons,
    citationReasonAuthor: reasons.author,
    onSaveCitationReason: saveReason,
    onDeleteCitationReason: deleteReason,
    onOpenCitationUse: openUse,
  };
}
