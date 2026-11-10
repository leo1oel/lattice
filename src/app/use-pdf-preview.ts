import { useMemo, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { pdfBytesFingerprint, pdfBytesToObjectUrl } from "../pdf/pdf-bytes";
import type { LivePreviewBuildHooks } from "../live-preview/use-live-preview";
import { clearTimer, restartTimer, useStableHandlers } from "./effect-helpers";

type Ref<T> = { readonly current: T };

/** The live preview's name for the files a build read, and whether it ran quietly. */
type LiveBase = { token: number | null; quiet: boolean };

/**
 * The root document whose PDF the preview shows, and whether the writer asked
 * for the build that showed it. A new value each time the preview turns to
 * another document, or a requested build lands: the PDF tabs follow it
 * (src/trellis/compiled-pdf-tabs.ts).
 */
export type ShownPdf = Readonly<{ document: string; requested: boolean }>;

/** A pending preview: the bytes, and what they were built from. */
type Pending = { bytes: ArrayBuffer; live: LiveBase; document: string; requested: boolean };

/** The preview's URL, and whose PDF it is. */
type PreviewState = Readonly<{ url: string | null; shown: ShownPdf | null }>;
type PreviewAction = { type: "url"; url: string | null } | { type: "shown"; shown: ShownPdf | null };

function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  if (action.type === "url") return state.url === action.url ? state : { ...state, url: action.url };
  return { ...state, shown: action.shown };
}

/** Now showing `bytes` (at `url`) of `document`. */
function displayPdf(
  held: PreviewHeld, displayed: { current: ArrayBuffer | null }, dispatch: (action: PreviewAction) => void,
  { bytes, url, document, requested }: { bytes: ArrayBuffer | null; url: string | null; document: string | null; requested: boolean },
) {
  if (held.url) URL.revokeObjectURL(held.url);
  held.url = url;
  dispatch({ type: "url", url });
  displayed.current = bytes;
  if (bytes && document) nameShown(held, dispatch, { bytes, document, requested });
}

/** The PDF on screen is `document`'s `bytes`. */
function nameShown(
  held: PreviewHeld, dispatch: (action: PreviewAction) => void,
  { bytes, document, requested }: { bytes: ArrayBuffer; document: string; requested: boolean },
) {
  held.shownBytes.set(document, bytes);
  if (requested || document !== held.document) dispatch({ type: "shown", shown: { document, requested } });
  held.document = document;
}

/** What the preview holds between renders (one ref: each hook is paid for on every App render). */
type PreviewHeld = {
  url: string | null;
  fingerprint: string | null;
  /** The document the URL shows. */
  document: string | null;
  /** Each document's bytes as last shown this session. */
  shownBytes: Map<string, ArrayBuffer>;
  timer: { current: number | null };
  /** Stable preview payload — debounced so automatic rebuilds do not thrash pdf.js. */
  pending: Pending | null;
};

/**
 * The compiled PDF in the preview: the last build's bytes, debounced so
 * automatic rebuilds do not thrash pdf.js, and the root document they are
 * of. Each document's last shown bytes are kept, so its own tab shows them
 * once another document's build is in front.
 */
export function usePdfPreview({ livePreview, projectRef }: {
  livePreview?: Ref<LivePreviewBuildHooks | null>;
  projectRef: Ref<ProjectSnapshot | null>;
}) {
  const [{ url: pdfUrl, shown }, dispatch] = useReducer(previewReducer, { url: null, shown: null });
  /** Each document's bytes as last shown this session, for its own tab (read when the tab mounts). */
  const shownBytes = useMemo(() => new Map<string, ArrayBuffer>(), []);
  const heldRef = useRef<PreviewHeld>({ url: null, fingerprint: null, document: null, shownBytes, timer: { current: null }, pending: null });
  const displayedPdfBytesRef = useRef<ArrayBuffer | null>(null);
  /** Bumped when leaving a project so a late build cannot revive a stale PDF. */
  const generationRef = useRef(0);

  // Stable for the hook's life: the build pipeline keys its callbacks on them.
  const { show, reset } = useStableHandlers({
    show: (bytes: ArrayBuffer, generation: number, immediate: boolean, live: LiveBase, document: string, requested: boolean) => {
      if (generation !== generationRef.current) return;
      const held = heldRef.current;
      // LaTeX rewrites PDF metadata on every compile, so bytes almost always
      // change. Debounce preview updates for autosave compiles so pdf.js is
      // not destroyed mid-load on every keystroke pause.
      const pending = held.pending;
      if (pending && pending.document !== document) held.shownBytes.set(pending.document, pending.bytes);
      held.pending = { bytes, live, document, requested: requested || (pending?.requested === true && pending.document === document) };
      clearTimer(held.timer);
      const apply = () => {
        const next = held.pending;
        if (!next) return;
        const fingerprint = pdfBytesFingerprint(next.bytes);
        held.pending = null;
        // The same pages as on screen: they hold what this build compiled now.
        if (fingerprint === held.fingerprint) {
          livePreview?.current?.baseShown(next.live.token);
          nameShown(held, dispatch, next);
          return;
        }
        held.fingerprint = fingerprint;
        livePreview?.current?.baseLoading(next.live.token, next.live.quiet);
        displayPdf(held, displayedPdfBytesRef, dispatch, { bytes: next.bytes, url: pdfBytesToObjectUrl(next.bytes), document: next.document, requested: next.requested });
      };
      // Another document's PDF is no rebuild to wait out: its tab turns at once.
      if (immediate || document !== held.document) apply();
      else restartTimer(held.timer, 1_200, apply);
    },

    /**
     * Drop the outgoing project's preview, invalidating any in-flight build's,
     * and show the PDF already on disk, if any, while latexmk checks for
     * changes. Which document it is of stays unnamed until a build says: the
     * backend reads a one-off root's PDF (a chapter, a figure) while one
     * stands. `onRead` hears the fingerprint of what was read.
     */
    reset: (projectRoot: string, onRead: (fingerprint: string) => void) => {
      const generation = ++generationRef.current;
      const held = heldRef.current;
      held.fingerprint = null;
      held.document = null;
      held.shownBytes.clear();
      held.pending = null;
      clearTimer(held.timer);
      displayPdf(held, displayedPdfBytesRef, dispatch, { bytes: null, url: null, document: null, requested: false });
      dispatch({ type: "shown", shown: null });
      const current = () => generation === generationRef.current && projectRef.current?.root === projectRoot && held.fingerprint === null;
      void invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot })
        .then((pdfBytes) => {
          if (!current()) return;
          const fingerprint = pdfBytesFingerprint(pdfBytes);
          held.fingerprint = fingerprint;
          onRead(fingerprint);
          displayPdf(held, displayedPdfBytesRef, dispatch, { bytes: pdfBytes, url: pdfBytesToObjectUrl(pdfBytes), document: null, requested: false });
        })
        .catch(() => {
          // A new or cleaned project has no cached PDF; the initial build
          // remains the source of its first preview.
        });
    },
  });

  return { pdfUrl, shown, displayedPdfBytesRef, generationRef, show, reset, shownBytes };
}
