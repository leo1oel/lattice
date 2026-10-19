import type { BuildStep } from "../app-types";

/**
 * The passes of the build running now, as the backend announces them
 * (`build-progress`), and when it started on `performance.now()`'s clock, so
 * the pass still running can count its own time.
 */
type BuildProgress = { steps: BuildStep[]; startedAt: number };

/**
 * The running build's progress, held outside React state: only the Build
 * button's card reads it, and only while it is open, so a pass starting
 * re-renders that card and nothing else (App, the panels' headers).
 */
export type BuildProgressStore = {
  get: () => BuildProgress | null;
  subscribe: (listener: () => void) => () => void;
};

export function createProgressStore(): BuildProgressStore & { set: (next: BuildProgress | null) => void } {
  let value: BuildProgress | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export const BUILD_PROGRESS_EVENT = "build-progress";
export type BuildProgressEvent = { projectRoot: string; progressId: number | null; elapsedMs: number; steps: BuildStep[] };
