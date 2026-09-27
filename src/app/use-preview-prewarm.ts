import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary, ProjectSnapshot } from "../app-types";
import { markdownFrontmatterEnd, stripFrontmatter } from "../app-utils";
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
 * file types, the Markdown search index, and a parsed preview of whichever
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
    // Chunk downloads can overlap the normal project setup without mounting
    // hidden previews or changing user-visible state. Idle-gated: firing the
    // burst immediately (visual editor + pdf viewer + worker can total ~4 MB)
    // competes with the first real editor mount for main-thread time.
    const cancelWarm = whenIdle(() => {
      void Promise.all([canvasModule, loadCanvasPrewarm()]).then(([, warm]) => {
        if (!cancelled) warm.prewarmProjectPreviewModules(paths);
      });
    }, 3_000, 300);
    // Keep the lightweight search index warm, but do not parse every Markdown
    // file into ProseMirror in the background. A project with many papers can
    // otherwise spend hundreds of milliseconds in each "idle" callback while
    // the user is scrolling or trying to open a file.
    void workspaceIndex.update(project.files);
    return () => {
      cancelled = true;
      cancelWarm();
    };
  }, [workspaceIndex, project]);

  const stateRef = useRef({
    generation: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    cancelIdle: null as (() => void) | null,
    target: null as string | null,
    warmed: new Set<string>(),
    inFlight: new Set<string>(),
  });
  const cancelPreviewPrewarm = useCallback(() => {
    const state = stateRef.current;
    state.generation += 1;
    state.target = null;
    if (state.timer != null) globalThis.clearTimeout(state.timer);
    state.timer = null;
    state.cancelIdle?.();
    state.cancelIdle = null;
  }, []);
  const schedulePreviewPrewarm = useCallback((key: string, task: PrewarmTask) => {
    const state = stateRef.current;
    if (state.warmed.has(key) || state.inFlight.has(key) || state.target === key) return;
    cancelPreviewPrewarm();
    state.target = key;
    const generation = state.generation;
    const isCurrent = () => state.generation === generation && state.target === key;
    const run = () => {
      state.cancelIdle = null;
      // Intent can move again while an earlier parse is still running. Keep
      // speculative work strictly bounded instead of allowing a fast sweep
      // over the tree to queue a project-sized burst of parses.
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
    state.timer = globalThis.setTimeout(() => {
      state.timer = null;
      if (isCurrent()) state.cancelIdle = whenIdle(run, 800, 0);
    }, 120);
  }, [cancelPreviewPrewarm]);
  useEffect(() => {
    cancelPreviewPrewarm();
    stateRef.current.warmed.clear();
    return cancelPreviewPrewarm;
  }, [cancelPreviewPrewarm, project?.root]);

  const prewarmFile = useCallback((kind: "file" | "paper", path: string, prepare: (source: string) => string) => {
    const root = projectRef.current?.root;
    if (!root) return;
    schedulePreviewPrewarm(`${kind}:${root}:${path}`, async (isCurrent) => {
      const source = await invoke<string>("read_project_file", { path, projectRoot: root });
      // A Paper without a local reading has nothing to parse yet.
      if ((kind === "paper" && !source) || !isCurrent() || projectRef.current?.root !== root) return false;
      const startedAt = performance.now();
      const [, warm] = await Promise.all([loadDocumentCanvas(), loadCanvasPrewarm()]);
      if (!isCurrent()) return false;
      await warm.prewarmMarkdownPreviewDocument(path, prepare(source));
      measure("lattice:markdown-prewarm", startedAt, { path });
      return isCurrent();
    });
  }, [projectRef, schedulePreviewPrewarm]);

  const { activeFile, activePaperId, paperView } = current;
  const prewarmLikelyProjectFile = useCallback((path: string) => {
    if (!/\.mdx?$/i.test(path) || path === activeFile) return;
    prewarmFile("file", path, (source) => source.slice(markdownFrontmatterEnd(source)));
  }, [activeFile, prewarmFile]);
  const prewarmLikelyPaper = useCallback((paper: PaperSummary) => {
    if (!paper.arxivId || activePaperId === paper.arxivId) return;
    const useBlog = Boolean(paper.hasBlog && (paperView === "blog" || !paper.hasFullText));
    prewarmFile("paper", paperDocumentPath(paper.arxivId, useBlog ? "blog" : "fulltext"), useBlog ? (source) => source : stripFrontmatter);
  }, [activePaperId, paperView, prewarmFile]);

  return { workspaceIndex, cancelPreviewPrewarm, prewarmLikelyProjectFile, prewarmLikelyPaper };
}
