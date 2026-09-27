import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitFileStatus, GitStatus, ProjectSnapshot } from "../app-types";
import { subscribeTauriEvent } from "./effect-helpers";

/**
 * The open project's snapshot and its imperative identity.
 *
 * `projectRef` is what async work compares against: it is nulled the moment a
 * root-changing command starts (see beginTransition) and re-published when
 * React commits the next snapshot, so a result computed for project A cannot
 * land in project B during the gap between the backend switch and the render.
 */
export function useProjectState() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const projectRef = useRef<ProjectSnapshot | null>(project);
  const projectBeforeTransitionRef = useRef<ProjectSnapshot | null>(null);
  // Incremented before any command that can replace the backend project root.
  // Long-running work captures this value so results from A cannot update B
  // during the short gap between the backend switch and React committing B.
  const projectOperationGenerationRef = useRef(0);
  const projectRefreshGenerationRef = useRef(0);
  /** Optimistic tree edits in flight; background refreshes must not undo them. */
  const projectTreeMutationCountRef = useRef(0);
  useLayoutEffect(() => {
    projectRef.current = project;
    projectBeforeTransitionRef.current = null;
  }, [project]);

  /** Claim the backend root for a switch: invalidate work scoped to the old one. */
  const beginTransition = useCallback(() => {
    if (projectRef.current) projectBeforeTransitionRef.current = projectRef.current;
    projectOperationGenerationRef.current += 1;
    // A root-changing backend command may finish before React commits the new
    // snapshot. Nulling only the imperative identity closes that gap without
    // flashing the welcome screen or discarding the rendered old project.
    projectRef.current = null;
  }, []);
  const cancelProjectTransition = useCallback(() => {
    if (!projectRef.current) projectRef.current = projectBeforeTransitionRef.current;
    projectBeforeTransitionRef.current = null;
  }, []);

  /** Snapshot the current project identity; the predicate stays true while it owns the window. */
  const captureProjectScope = useCallback(() => {
    const root = projectRef.current?.root;
    const generation = projectOperationGenerationRef.current;
    return () => projectRef.current?.root === root && projectOperationGenerationRef.current === generation;
  }, []);

  /** Re-read the tree only; the latest refresh wins. */
  const reconcileProjectTree = useCallback(async () => {
    const refreshGeneration = ++projectRefreshGenerationRef.current;
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    if (refreshGeneration === projectRefreshGenerationRef.current) setProject(snapshot);
    return snapshot;
  }, []);

  /** Hold background refreshes off while `mutation` edits the tree optimistically. */
  const withTreeMutation = useCallback(async <T,>(mutation: () => Promise<T>): Promise<T> => {
    projectTreeMutationCountRef.current += 1;
    try {
      return await mutation();
    } finally {
      projectTreeMutationCountRef.current = Math.max(0, projectTreeMutationCountRef.current - 1);
    }
  }, []);

  useEffect(() => () => {
    projectOperationGenerationRef.current += 1;
    projectRef.current = null;
  }, []);

  return {
    project, setProject, projectRef, projectBeforeTransitionRef,
    projectOperationGenerationRef, projectRefreshGenerationRef, projectTreeMutationCountRef,
    beginTransition, cancelProjectTransition, captureProjectScope,
    reconcileProjectTree, withTreeMutation,
  };
}

export type ProjectState = ReturnType<typeof useProjectState>;

export type ProjectGitStatus = { projectRoot: string; files: GitFileStatus[]; remoteUrl: string | null };

/**
 * Keep the tree and git status fresh while the Project sidebar shows them.
 * Event-driven: the Rust watcher coalesces filesystem bursts into one
 * project-fs-changed broadcast (its payload carries the root so a window
 * showing another project ignores it); the interval is only a safety net for
 * anything a watcher can genuinely miss (network volumes, overflow).
 */
export function useProjectTreeWatch(state: ProjectState, enabled: boolean) {
  const { project, setProject, projectRef, projectRefreshGenerationRef, projectTreeMutationCountRef } = state;
  const [gitStatus, setGitStatus] = useState<ProjectGitStatus>({ projectRoot: "", files: [], remoteUrl: null });
  useEffect(() => {
    const initialProject = projectRef.current;
    if (!initialProject || !enabled) return;
    let stopped = false;
    let checking = false;
    const refresh = async () => {
      if (checking || projectTreeMutationCountRef.current > 0) return;
      checking = true;
      const refreshGeneration = ++projectRefreshGenerationRef.current;
      try {
        const [snapshotResult, gitStatusResult] = await Promise.allSettled([
          invoke<ProjectSnapshot>("refresh_project"),
          invoke<GitStatus>("git_status"),
        ]);
        const currentProject = projectRef.current;
        const quiet = !stopped && projectTreeMutationCountRef.current === 0;
        if (
          quiet
          && refreshGeneration === projectRefreshGenerationRef.current
          && currentProject
          && snapshotResult.status === "fulfilled"
          && snapshotResult.value.root === currentProject.root
          && JSON.stringify(snapshotResult.value.files) !== JSON.stringify(currentProject.files)
        ) {
          setProject(snapshotResult.value);
        }
        if (quiet && currentProject?.root === initialProject.root && gitStatusResult.status === "fulfilled") {
          const status = gitStatusResult.value;
          const files = status?.repository ? status.files : [];
          const remoteUrl = status?.repository ? status.remoteUrl ?? null : null;
          setGitStatus((current) => (
            current.projectRoot === currentProject.root
            && JSON.stringify(current.files) === JSON.stringify(files)
            && current.remoteUrl === remoteUrl
              ? current
              : { projectRoot: currentProject.root, files, remoteUrl }
          ));
        }
      } catch {
        // The next poll retries after transient filesystem races.
      } finally {
        checking = false;
      }
    };
    void refresh();
    void invoke("watch_project").catch(() => {
      // Watcher-less operation degrades to the fallback poll below.
    });
    const stopListening = subscribeTauriEvent<{ root: string }>("project-fs-changed", (payload) => {
      if (payload.root === initialProject.root) void refresh();
    });
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => {
      stopped = true;
      stopListening();
      window.clearInterval(timer);
    };
  }, [enabled, project?.root, projectRef, projectRefreshGenerationRef, projectTreeMutationCountRef, setProject]);
  /** Only the open project's status; a stale root reads as clean. */
  const visible = gitStatus.projectRoot === project?.root ? gitStatus : null;
  return { gitStatus, setGitStatus, gitFiles: visible?.files ?? [], gitRemoteUrl: visible?.remoteUrl ?? null };
}
