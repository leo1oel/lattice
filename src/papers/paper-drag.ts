import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PaperSummary } from "../app-types";
import { paperLinkHref } from "./paper-link";

export const PAPER_DRAG_TYPE = "application/x-lattice-paper";
export const PAPER_NATIVE_DRAG = "paper-native-drag";
const PAPER_DRAG_URI = "lattice-paper:";
export type PaperDrag = { projectRoot: string; arxivId: string; citationKey?: string };
export type NativePaperDrag = { id: string; paper: PaperDrag | null };

export function beginPaperDrag(data: DataTransfer, projectRoot: string, paper: PaperSummary, owner?: string) {
  data.effectAllowed = "copy";
  const identity: PaperDrag = { projectRoot, arxivId: paper.arxivId, citationKey: paper.citationKey };
  const payload = JSON.stringify(identity);
  data.setData(PAPER_DRAG_TYPE, payload);
  const uri = PAPER_DRAG_URI + encodeURIComponent(payload);
  data.setData("text/uri-list", uri);
  // Native WebKit → Chromium transfers may preserve only plain text. Keep
  // the identity there too: the receiving editor, not the source window,
  // chooses TeX or Markdown syntax. A bare @key silently becomes TeX prose.
  data.setData("text/plain", uri);
  // Tauri's native file-drop handler consumes even non-file drops before
  // WKWebView sees them. Give the owner the identity separately; its native
  // drop callback supplies the pointer position. Finder drops stay native.
  if ("__TAURI_INTERNALS__" in window) {
    const target = owner ?? getCurrentWindow().label;
    const id = crypto.randomUUID();
    const started = emitTo(target, PAPER_NATIVE_DRAG, { id, paper: identity } satisfies NativePaperDrag);
    void started.catch(() => {});
    window.addEventListener("dragend", () => {
      void started.then(() => emitTo(target, PAPER_NATIVE_DRAG, { id, paper: null } satisfies NativePaperDrag)).catch(() => {});
    }, { once: true });
  }
}

function paperDragUri(data: DataTransfer): string | undefined {
  return [data.getData("text/uri-list"), data.getData("text/plain")]
    .find((value) => value.startsWith(PAPER_DRAG_URI));
}

export function hasPaperDrag(data: DataTransfer | null): boolean {
  return Boolean(data && (Array.from(data.types).includes(PAPER_DRAG_TYPE)
    || paperDragUri(data)));
}

/** Resolve against today's library, never trust metadata from another project/window. */
export function resolvePaperDrag(data: DataTransfer | null, projectRoot: string, papers: readonly PaperSummary[]): PaperSummary | undefined {
  try {
    const uri = data && paperDragUri(data);
    const payload = data?.getData(PAPER_DRAG_TYPE)
      || (uri ? decodeURIComponent(uri.slice(PAPER_DRAG_URI.length)) : "");
    const value: PaperDrag = JSON.parse(payload);
    if (!value || value.projectRoot !== projectRoot) return;
    return papers.find((paper) => paper.arxivId === value.arxivId && paper.citationKey === value.citationKey);
  } catch { return; }
}

export function paperCitationLabel(paper: PaperSummary): string {
  return `@${paper.citationKey || paper.title}`;
}

export function paperMarkdownCitation(path: string, paper: PaperSummary): string {
  const label = paperCitationLabel(paper).replace(/[\\[\]*_`]/g, "\\$&");
  return paper.arxivId && (paper.hasFullText || paper.hasBlog)
    ? `[${label}](${paperLinkHref(path, paper)})`
    : label;
}
