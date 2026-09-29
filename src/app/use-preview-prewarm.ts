import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary, ProjectSnapshot } from "../app-types";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { MarkdownWorkspaceIndex } from "../editor/markdown/markdown-workspace-index";
import { whenIdle } from "./effect-helpers";
import { paperDocumentPath, type PaperView } from "./use-document-buffers";

export const loadDocumentCanvas = () => import("../canvas/document-canvas");
const loadCanvasPrewarm = () => import("../canvas/canvas-prewarm");

function measure(name: string, start: number, detail: object) {
  try {
    performance.measure(name, { start, end: performance.now(), detail });
  } catch {
    // Older WebKit builds do not support PerformanceMeasureOptions.detail.
  }
}

type PrewarmTask = (isCurrent: () => boolean) => Promise<boolean>;

/**
 * Speculative, idle-time preparation: editor/preview chunks for the project's
 * file types, the Markdown search index, and the visual editor for whichever
 * document the reader is hovering toward.
 */
export function usePreviewPrewarm(
  project: ProjectSnapshot | null,
  projectRef: RefObject<ProjectSnapshot | null>,
  current: { activeFile: string; activePaperId: string | undefined; paperView: PaperView },
) {
  const workspaceIndex = useMemo(
    () => new MarkdownWorkspaceIndex((path) => invoke<string>("read_project_file", { path })),
    [],
  );
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const paths = flattenProjectPaths(project.files);
    const canvasModule = loadDocumentCanvas();
    // Chunk downloads (visual editor + pdf viewer + worker, ~4 MB) are
    // idle-gated so they do not compete with the first real editor mount.
    const cancelWarm = whenIdle(() => {
      void Promise.all([canvasModule, loadCanvasPrewarm()]).then(([, warm]) => {
        if (!cancelled) warm.prewarmProjectPreviewModules(paths);
      });
    }, 3_000, 300);
    // Keep the lightweight search index warm, but never parse every Markdown
    // file into ProseMirror in the background: with many papers each "idle"
    // callback could cost hundreds of milliseconds.
    void workspaceIndex.update(project.files);
    return () => {
      cancelled = true;
      cancelWarm();
    };
  }, [workspaceIndex, project]);

  const stateRef = useRef({
    generation: 0,
    /** Cancels whichever step is pending: the settle timer, then the idle callback it hands off to. */
    cancel: null as (() => void) | null,
    target: null as string | null,
    warmed: new Set<string>(),
    inFlight: new Set<string>(),
  });
  const cancelPreviewPrewarm = useCallback(() => {
    const state = stateRef.current;
    state.generation += 1;
    state.target = null;
    state.cancel?.();
    state.cancel = null;
  }, []);
  const schedulePreviewPrewarm = useCallback((key: string, task: PrewarmTask) => {
    const state = stateRef.current;
    if (state.warmed.has(key) || state.inFlight.has(key) || state.target === key) return;
    cancelPreviewPrewarm();
    state.target = key;
    const generation = state.generation;
    const isCurrent = () => state.generation === generation && state.target === key;
    const run = () => {
      state.cancel = null;
      // Keep speculative work bounded: a fast sweep over the tree must not queue a burst of parses.
      if (!isCurrent() || state.inFlight.size >= 2) return;
      state.inFlight.add(key);
      void task(isCurrent).then((warmed) => {
        if (!warmed || !isCurrent()) return;
        state.warmed.add(key);
        while (state.warmed.size > 4) state.warmed.delete(state.warmed.values().next().value!);
      }).catch(() => undefined).finally(() => {
        state.inFlight.delete(key);
      });
    };
    const timer = globalThis.setTimeout(() => {
      if (isCurrent()) state.cancel = whenIdle(run, 800, 0);
    }, 120);
    state.cancel = () => globalThis.clearTimeout(timer);
  }, [cancelPreviewPrewarm]);
  useEffect(() => {
    cancelPreviewPrewarm();
    stateRef.current.warmed.clear();
    return cancelPreviewPrewarm;
  }, [cancelPreviewPrewarm, project?.root]);

  const prewarmFile = useCallback((kind: "file" | "paper", path: string) => {
    const root = projectRef.current?.root;
    if (!root) return;
    schedulePreviewPrewarm(`${kind}:${root}:${path}`, async (isCurrent) => {
      const startedAt = performance.now();
      const [, warm] = await Promise.all([loadDocumentCanvas(), loadCanvasPrewarm()]);
      if (!isCurrent() || projectRef.current?.root !== root) return false;
      // The editor keeps no parse cache across mounts, so the document itself is not read ahead.
      await warm.prewarmMarkdownPreviewDocument();
      measure("lattice:markdown-prewarm", startedAt, { path });
      return isCurrent();
    });
  }, [projectRef, schedulePreviewPrewarm]);

  const { activeFile, activePaperId, paperView } = current;
  const prewarmLikelyProjectFile = useCallback((path: string) => {
    if (!/\.mdx?$/i.test(path) || path === activeFile) return;
    prewarmFile("file", path);
  }, [activeFile, prewarmFile]);
  const prewarmLikelyPaper = useCallback((paper: PaperSummary) => {
    if (!paper.arxivId || activePaperId === paper.arxivId) return;
    const useBlog = Boolean(paper.hasBlog && (paperView === "blog" || !paper.hasFullText));
    prewarmFile("paper", paperDocumentPath(paper.arxivId, useBlog ? "blog" : "fulltext"));
  }, [activePaperId, paperView, prewarmFile]);

  return { workspaceIndex, cancelPreviewPrewarm, prewarmLikelyProjectFile, prewarmLikelyPaper };
}
