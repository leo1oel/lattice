/**
 * What the Tauri app's window keeps of the project for the Agent, read here
 * by the Agent's page through the same commands (`agent/commands.rs` answers):
 *
 * - the paper library (`use-project-library.ts`'s `list_papers`), which the
 *   page posts to the frame as `buildAgentPaperLibrary` builds it, again
 *   whenever the project watcher reports a change under `.research/`;
 * - the project's annotations, for the annotation tools (`propose`, `ask`)
 *   and the Agent's view of the project's comments. The Tauri app keeps them
 *   in its comments store (`use-editor-comments.ts`) and records the tools'
 *   answers through its revision rounds (`annotation-rounds.ts`); the GPUI
 *   app has no comments panel yet, so the page holds the store itself,
 *   loaded once per project and saved as the Tauri store saves, and runs the
 *   same revision rounds over it. A proposal recorded here is the one the
 *   Tauri app's review shows.
 *
 * The page is the only writer of the annotations in the GPUI app, so it never
 * reads them back from disk under its own saves.
 */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { host } from "../shared/host";
import { toMessage } from "../../../src/app-utils";
import { useLatestRef } from "../../../src/hooks/use-latest-ref";
import { showError } from "../../../src/app/notify";
import { i18n } from "../../../src/i18n";
import { AnnotationRounds, type AnnotationRoundsDeps } from "../../../src/app/annotation-rounds";
import type { AnnotationsState } from "../../../src/app/use-editor-comments";
import { buildAgentPaperLibrary, type AgentPaperLibrarySnapshot } from "../../../src/agent/agent-paper-library";
import type { AnnotationToolHost } from "../../../src/agent/agent-annotations";
import type { BuildAgentCommentsOptions } from "../../../src/agent/agent-editor-comments";
import type { PaperSummary } from "../../../src/app-types";

/** A reducer that takes the newest value whole. */
const replace = <T,>(_: T, next: T): T => next;

/** The project files the paper library is read from. */
const PAPERS_PREFIX = ".research/";

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
    const read = () => {
      const current = ++generation;
      void invoke<PaperSummary[]>("list_papers").then(
        (rows) => { if (current === generation) setPapers(rows); },
        () => undefined,
      );
    };
    read();
    const stop = host().on("agent:files-changed", (payload) => {
      if (touches(changedPaths(payload), (path) => path.startsWith(PAPERS_PREFIX))) read();
    });
    return () => {
      generation += 1;
      stop();
    };
  }, [projectRoot]);
  return useMemo(() => buildAgentPaperLibrary({ workspaceRoot: projectRoot, papers }), [papers, projectRoot]);
}

/** The project's Overleaf link and its documents' paths, as the owner reports them. */
export type OverleafState = { linked: boolean; docPaths: Record<string, string> };

const NOT_LINKED: OverleafState = { linked: false, docPaths: {} };

type Overleaf = Pick<BuildAgentCommentsOptions, "overleafThreads" | "overleafAnchors" | "overleaf">;

/** The project's annotations store, with the annotation tools' host and the comments' options. */
export function useAgentAnnotations(projectRoot: string): {
  annotationTools: () => AnnotationToolHost | null;
  commentsOptions: () => BuildAgentCommentsOptions | null;
} {
  const stateRef = useRef<AnnotationsState>({ annotations: [], rounds: [] });
  /** null while reading; the reason when the read failed (nothing is saved then). */
  const loadedRef = useRef<{ error: string | null } | null>(null);
  /** The annotated files' text, to tell where each note's anchor stands. */
  const sourcesRef = useRef(new Map<string, string>());
  const [overleafState, setOverleafState] = useReducer(replace<OverleafState>, NOT_LINKED);
  const overleafRef = useRef<Overleaf>({ overleafThreads: [], overleafAnchors: [], overleaf: { status: "not-linked" } });

  const rounds = useMemo(() => new AnnotationRounds(), []);

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
    const projectRootRef = { current: projectRoot as string | null };
    // The revision rounds reach the store only through `stateRef` and
    // `commit`, and the window only to read a file (`activeFileRef` names
    // none, so every file is read from disk) or to show what this window
    // has no panel for.
    const store = {
      stateRef,
      commit: (change: (current: AnnotationsState) => AnnotationsState): boolean => {
        const loaded = loadedRef.current;
        if (loaded?.error !== null) {
          // The Tauri store's own words (`use-editor-comments.ts`).
          const error = loaded?.error ?? null;
          showError(error === null
            ? i18n._(msg`This project's annotations are still being read. Try again in a moment.`)
            : i18n._(msg`This project's annotations could not be read, so changes to them are not saved: ${error}`));
          return false;
        }
        const current = stateRef.current;
        const next = change(current);
        if (next === current) return false;
        stateRef.current = next;
        // The broker numbers the saves (`agent/commands.rs`).
        void invoke<void>("save_annotations", { projectRoot, annotations: next.annotations, rounds: next.rounds, save: 0 })
          .catch((reason: unknown) => showError(toMessage(reason)));
        return true;
      },
    } as unknown as AnnotationRoundsDeps["store"];
    rounds.attach({
      store,
      projectRootRef,
      activeFileRef: { current: "" },
      sourceRef: { current: "" },
      openProjectFile: async () => undefined,
      author: { id: "", name: "" },
      openPanel: () => undefined,
      openHistoryEntry: () => undefined,
      save: async () => true,
      reloadAfterRestore: async () => undefined,
    } as AnnotationRoundsDeps);
    return () => {
      live = false;
      projectRootRef.current = null;
      stop();
      rounds.reset();
    };
  }, [projectRoot, rounds]);

  // The owner's Overleaf link; a linked project's threads are read through it.
  useEffect(() => host().on("agent:overleaf", (payload) => {
    const next = payload as Partial<OverleafState> | null;
    setOverleafState({ linked: next?.linked === true, docPaths: next?.docPaths ?? {} });
  }), []);
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
    annotationTools: () => (loadedRef.current?.error === null ? rounds.toolHost : null),
    // As `useEditorComments`'s `agentOptionsRef` builds them; the Overleaf
    // half refreshes when the Agent asks (`readAgentCommentsSnapshot`).
    commentsOptions: () => loadedRef.current?.error === null ? {
      workspaceRoot: projectRoot,
      localComments: stateRef.current.annotations.filter((item) => !item.citation),
      ...overleafRef.current,
      docPaths: docPathsRef.current,
      currentSources: sourcesRef.current,
    } : null,
  }), [docPathsRef, projectRoot, rounds]);
}
