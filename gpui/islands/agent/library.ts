/**
 * What the Tauri app's window keeps of the project for the Agent, read here
 * by the Agent's page through the same commands (`agent/commands.rs` answers):
 *
 * - the paper library (`use-project-library.ts`'s `list_papers`), which the
 *   page posts to the frame as `buildAgentPaperLibrary` builds it, again
 *   whenever the project watcher reports a change to what `list_papers`
 *   reads: a `.bib`, the paper bundles or the project's manifest;
 * - the project's annotations, for the annotation tools (`propose`, `ask`)
 *   and the Agent's view of the project's comments. The Tauri app keeps them
 *   in its comments store (`use-editor-comments.ts`) and records the tools'
 *   answers through its revision rounds (`annotation-rounds.ts`); here both
 *   are the window's own (`agent/surface/annotations.rs`), the store the
 *   file's one writer. The page only reads: it keeps a view of the store,
 *   which the window keeps current (`agent:annotations`), and hands each
 *   tool call to the window's rounds to record into the open round
 *   (`annotation-tools.ts`).
 */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { host } from "../shared/host";
import { isBibFilePath, toMessage } from "../../../src/app-utils";
import { useLatestRef } from "../../../src/hooks/use-latest-ref";
import { showError } from "../../../src/app/notify";
import type { AnnotationsState } from "../../../src/app/use-editor-comments";
import { annotationToolHost } from "./annotation-tools";
import { buildAgentPaperLibrary, type AgentPaperLibrarySnapshot } from "../../../src/agent/agent-paper-library";
import type { AnnotationToolHost } from "../../../src/agent/agent-annotations";
import type { BuildAgentCommentsOptions } from "../../../src/agent/agent-editor-comments";
import type { PaperSummary } from "../../../src/app-types";

/** A reducer that takes the newest value whole. */
const replace = <T,>(_: T, next: T): T => next;

/** The paper bundles and the manifest naming the primary bibliography, as `list_papers` reads them. */
const PAPERS_DIR = ".research/papers";
const MANIFEST = ".research/project.json";

/**
 * How long a burst that reached the library waits for the next before it is
 * read again, as `use-project-library.ts` waits for a .bib.
 */
const LIBRARY_WATCH_DELAY_MS = 400;

/** The burst may have changed what `list_papers` reads: a .bib, a bundle, or a folder holding either input. */
function reachesLibrary(paths: readonly string[] | null): boolean {
  return touches(paths, (path) => isBibFilePath(path)
    || path.startsWith(`${PAPERS_DIR}/`)
    || [PAPERS_DIR, MANIFEST].some((input) => input === path || input.startsWith(`${path}/`)));
}

/** What the owner reports of a burst of changes on disk (`agent:files-changed`). */
function changedPaths(payload: unknown): readonly string[] | null {
  const paths = (payload as { paths?: unknown } | null)?.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : null;
}

/** The burst touched what `matches` names; a burst of unknown paths touches everything. */
export function touches(paths: readonly string[] | null, matches: (path: string) => boolean): boolean {
  return paths === null || paths.some((path) => matches(path.replace(/\\/g, "/")));
}

/** The project's papers, as the Agent's paper library snapshot. */
export function useAgentPaperLibrary(projectRoot: string): AgentPaperLibrarySnapshot {
  const [papers, setPapers] = useReducer(replace<PaperSummary[]>, []);
  useEffect(() => {
    let generation = 0;
    let timer: number | undefined;
    const read = () => {
      const current = ++generation;
      void invoke<PaperSummary[]>("list_papers").then(
        (rows) => { if (current === generation) setPapers(rows); },
        () => undefined,
      );
    };
    read();
    const stop = host().on("agent:files-changed", (payload) => {
      if (!reachesLibrary(changedPaths(payload))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(read, LIBRARY_WATCH_DELAY_MS);
    });
    return () => {
      window.clearTimeout(timer);
      generation += 1;
      stop();
    };
  }, [projectRoot]);
  return useMemo(() => buildAgentPaperLibrary({ workspaceRoot: projectRoot, papers }), [papers, projectRoot]);
}

/** The project's Overleaf link and its documents' paths, as the owner reports them. */
export type OverleafState = { linked: boolean; docPaths: Record<string, string> };

export const NOT_LINKED: OverleafState = { linked: false, docPaths: {} };

/** The owner's `agent:overleaf` payload. */
export function overleafState(payload: unknown): OverleafState {
  const next = payload as Partial<OverleafState> | null;
  return { linked: next?.linked === true, docPaths: next?.docPaths ?? {} };
}

type Overleaf = Pick<BuildAgentCommentsOptions, "overleafThreads" | "overleafAnchors" | "overleaf">;

/** The project's annotations store, with the annotation tools' host and the comments' options. */
export function useAgentAnnotations(projectRoot: string, overleafState: OverleafState): {
  annotationTools: () => AnnotationToolHost | null;
  commentsOptions: () => BuildAgentCommentsOptions | null;
} {
  const stateRef = useRef<AnnotationsState>({ annotations: [], rounds: [] });
  /** null while reading; the reason when the read failed (no tool runs then). */
  const loadedRef = useRef<{ error: string | null } | null>(null);
  /** The annotated files' text, to tell where each note's anchor stands. */
  const sourcesRef = useRef(new Map<string, string>());
  const overleafRef = useRef<Overleaf>({ overleafThreads: [], overleafAnchors: [], overleaf: { status: "not-linked" } });

  const toolsRef = useRef<AnnotationToolHost | null>(null);

  useEffect(() => {
    let live = true;
    stateRef.current = { annotations: [], rounds: [] };
    loadedRef.current = null;
    sourcesRef.current = new Map();
    const readSources = (paths: readonly string[]) => {
      for (const path of new Set(paths)) {
        void invoke<string>("read_project_file", { path, projectRoot }).then(
          (text) => { if (live) sourcesRef.current.set(path, text); },
          () => { if (live) sourcesRef.current.delete(path); },
        );
      }
    };
    const annotatedPaths = () => stateRef.current.annotations.map((annotation) => annotation.path);
    void invoke<AnnotationsState>("list_annotations").then(
      (loaded) => {
        if (!live) return;
        stateRef.current = { annotations: loaded.annotations ?? [], rounds: loaded.rounds ?? [] };
        loadedRef.current = { error: null };
        readSources(annotatedPaths());
      },
      (reason: unknown) => {
        if (live) loadedRef.current = { error: toMessage(reason) };
      },
    );
    const stop = host().on("agent:files-changed", (payload) => {
      const paths = changedPaths(payload);
      const annotated = annotatedPaths();
      readSources(paths === null ? annotated : annotated.filter((path) => paths.includes(path)));
    });
    const take = (notes: AnnotationsState) => {
      const known = new Set(annotatedPaths());
      stateRef.current = { annotations: notes.annotations ?? [], rounds: notes.rounds ?? [] };
      // The window tells only what its store has read: the read is good now.
      loadedRef.current = { error: null };
      readSources(annotatedPaths().filter((path) => !known.has(path)));
    };
    const stopStore = host().on("agent:annotations", (payload) => {
      if (live && payload && typeof payload === "object") take(payload as AnnotationsState);
    });
    // The tools' calls are recorded by the window; the page writes nothing.
    toolsRef.current = annotationToolHost(() => stateRef.current, (call) => {
      void invoke<void>("record_annotation_tool", { projectRoot, ...call })
        .catch((reason: unknown) => { if (live) showError(toMessage(reason)); });
    });
    return () => {
      live = false;
      toolsRef.current = null;
      stop();
      stopStore();
    };
  }, [projectRoot]);

  // The owner's Overleaf link (held above the surface, `main.tsx`); a linked
  // project's threads are read through it.
  useEffect(() => {
    let live = true;
    if (!overleafState.linked) {
      overleafRef.current = { overleafThreads: [], overleafAnchors: [], overleaf: { status: "not-linked" } };
      return;
    }
    overleafRef.current = { ...overleafRef.current, overleaf: { status: "cached" } };
    void Promise.all([
      invoke<BuildAgentCommentsOptions["overleafThreads"]>("overleaf_threads", { projectRoot }),
      invoke<BuildAgentCommentsOptions["overleafAnchors"]>("overleaf_comment_anchors", { projectRoot }),
    ]).then(
      ([overleafThreads, overleafAnchors]) => {
        if (live) overleafRef.current = { overleafThreads, overleafAnchors, overleaf: { status: "cached", fetchedAt: new Date().toISOString() } };
      },
      (reason: unknown) => {
        if (live) overleafRef.current = { ...overleafRef.current, overleaf: { status: "unavailable", error: toMessage(reason).slice(0, 500) } };
      },
    );
    return () => { live = false; };
  }, [overleafState.linked, projectRoot]);

  const docPaths = useMemo(() => new Map(Object.entries(overleafState.docPaths)), [overleafState.docPaths]);
  const docPathsRef = useLatestRef(docPaths);

  return useMemo(() => ({
    annotationTools: () => (loadedRef.current?.error === null ? toolsRef.current : null),
    // As `useEditorComments`'s `agentOptionsRef` builds them; the Overleaf
    // half refreshes when the Agent asks (`readAgentCommentsSnapshot`).
    commentsOptions: () => loadedRef.current?.error === null ? {
      workspaceRoot: projectRoot,
      localComments: stateRef.current.annotations.filter((item) => !item.citation),
      ...overleafRef.current,
      docPaths: docPathsRef.current,
      currentSources: sourcesRef.current,
    } : null,
  }), [docPathsRef, projectRoot]);
}
