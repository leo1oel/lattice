/* eslint-disable lingui/no-unlocalized-strings -- developer console lines only; the spike shows nothing in the interface. */
/**
 * A development spike: live preview for pdfLaTeX projects through FlashTeX
 * (src-tauri/lattice-core/src/flashtex_preview.rs), whose host typesets the
 * open file's unsaved text in tens of milliseconds and writes a real PDF.
 *
 * Off unless a developer sets `localStorage["lattice.dev.flashtex-preview"]`
 * to "1" and reopens the project; with it off nothing here runs and nothing
 * downloads. With it on, a pdfLaTeX project (or a XeLaTeX one, where the
 * developer built FlashTeX's XeTeX host and named it in
 * LATTICE_FLASHTEX_UNICODE_HOST) downloads the pinned FlashTeX once, copies
 * the project, and hands each PDF with the edit in it to the PDF panel the
 * normal build feeds (`onFlashtexPdf`, which use-build-pipeline.ts reads), so
 * only the pages that changed redraw. latexmk still builds on save, and its
 * PDF, diagnostics and SyncTeX are the ones everything else uses.
 *
 * Any failure (a Mac that cannot run it, no network, a host that dies) ends
 * the session without a word: the panel shows the normal build's PDF, as it
 * does with the flag off. The console says why.
 */
import { useEffect, useMemo, useReducer } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { whenIdle } from "../app/effect-helpers";
import { chunk } from "../lib/lazy-chunk";
import { onProjectFilesChanged } from "../project/project-files-changed";
import type { FlashtexSession } from "./flashtex-session";

const DEV_FLAG = "lattice.dev.flashtex-preview";

type FlashtexInstall = { supported: boolean; installed: boolean; unicode: boolean; version: string };

const loadSession = chunk(() => import("./flashtex-session"));

/** Whether a developer has asked for the FlashTeX preview in this browser profile. */
function flashtexPreviewWanted(): boolean {
  try {
    return localStorage.getItem(DEV_FLAG) === "1";
  } catch {
    return false;
  }
}

type PdfListener = (document: string, bytes: ArrayBuffer) => void;
const listeners = new Map<string, Set<PdfListener>>();

/** Hear each FlashTeX PDF of the project at `root`, until the returned disposer runs. */
export function onFlashtexPdf(root: string, listener: PdfListener): () => void {
  const forRoot = listeners.get(root) ?? new Set<PdfListener>();
  listeners.set(root, forRoot);
  forRoot.add(listener);
  return () => {
    forRoot.delete(listener);
    if (forRoot.size === 0) listeners.delete(root);
  };
}

function publish(root: string, document: string, bytes: ArrayBuffer) {
  for (const listener of listeners.get(root) ?? []) listener(document, bytes);
}

/**
 * The running session, and a count bumped when the watcher cannot say what
 * changed (an Overleaf pull of many files): the copy is then made again.
 */
type State = { attempt: number; session: FlashtexSession | null };
type Action = { type: "session"; session: FlashtexSession | null } | { type: "retry" };

function reduce(state: State, action: Action): State {
  if (action.type === "retry") return { ...state, attempt: state.attempt + 1 };
  return state.session === action.session ? state : { ...state, session: action.session };
}

function debug(message: string, detail?: unknown) {
  console.debug(`[flashtex-preview] ${message}`, detail ?? "");
}

export function useFlashtexPreview({ project, activeFile, source }: {
  project: ProjectSnapshot | null;
  activeFile: string;
  source: string;
}) {
  const root = project?.root ?? null;
  const engine = project?.manifest.engine;
  const rootDocuments = project?.manifest.rootDocuments;
  const mainFile = (rootDocuments?.find((document) => document.isDefault) ?? rootDocuments?.[0])?.path ?? null;
  // Read when the project opens: the flag is for developers, who reopen it.
  const wanted = useMemo(() => Boolean(root) && flashtexPreviewWanted(), [root]);
  const fits = engine === "pdflatex" || engine === "xelatex";
  const [{ attempt, session }, dispatch] = useReducer(reduce, { attempt: 0, session: null });

  useEffect(() => {
    if (!wanted || !fits || !root || !mainFile) return;
    let cancelled = false;
    let cancelIdle = () => {};
    let running: FlashtexSession | null = null;
    void (async () => {
      const install = await invoke<FlashtexInstall>("flashtex_preview_status");
      if (cancelled) return;
      if (!install.supported || (engine === "xelatex" && !install.unicode)) {
        debug(`not available for ${engine} here`, install);
        return;
      }
      if (!install.installed) {
        await new Promise<void>((resolve) => { cancelIdle = whenIdle(resolve, 5_000, 2_000); });
        if (cancelled) return;
        debug(`downloading FlashTeX ${install.version}`);
        await invoke("flashtex_preview_install", { onProgress: new Channel() });
        if (cancelled) return;
      }
      const [{ FlashtexSession }, id] = await Promise.all([
        loadSession(),
        invoke<number>("flashtex_preview_start", { projectRoot: root, mainFile, engine }),
      ]);
      if (cancelled) {
        void invoke("flashtex_preview_stop", { projectRoot: root, session: id }).catch(() => undefined);
        return;
      }
      running = new FlashtexSession(
        root, id, mainFile,
        (document, bytes) => publish(root, document, bytes),
        (reason) => {
          debug("ended", reason);
          if (!cancelled) dispatch({ type: "session", session: null });
        },
      );
      if (import.meta.env.DEV || import.meta.env.VITE_PERF_LAB) Object.assign(window, { __latticeFlashtex: running });
      dispatch({ type: "session", session: running });
      debug(`started for ${mainFile} (${engine})`);
      await running.warm();
    })().catch((reason: unknown) => debug("could not start", reason));
    return () => {
      cancelled = true;
      cancelIdle();
      running?.dispose();
      dispatch({ type: "session", session: null });
    };
  }, [attempt, engine, fits, mainFile, root, wanted]);

  useEffect(() => {
    session?.noteText(activeFile, source);
  }, [activeFile, session, source]);

  useEffect(() => {
    if (!session || !root) return;
    return onProjectFilesChanged(root, (paths) => {
      if (paths) void session.noteFilesChanged(paths);
      else dispatch({ type: "retry" });
    });
  }, [root, session]);
}
