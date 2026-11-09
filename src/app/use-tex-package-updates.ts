import { useCallback, useEffect, useReducer, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import type { TexPackageUpdateProgress, TexPackageUpdatesReport } from "../build/tex-package-updates";

type TexPackageUpdatesState = {
  /** The last check; null before one finishes, or without a tlmgr to ask. */
  report: TexPackageUpdatesReport | null;
  checking: boolean;
  /**
   * The update: present while it runs and after it ends, until a check
   * other than the one that follows it.
   */
  run: {
    progress: TexPackageUpdateProgress;
    running: boolean;
    /** Why it failed; null while running and after it succeeded. */
    error: string | null;
  } | null;
};

type Action =
  | { type: "check-started" }
  | { type: "checked"; report: TexPackageUpdatesReport | null; afterUpdate: boolean }
  | { type: "update-started" }
  | { type: "update-progress"; progress: TexPackageUpdateProgress }
  | { type: "update-finished"; error: string | null };

const IDLE: TexPackageUpdatesState = { report: null, checking: false, run: null };

function reducer(state: TexPackageUpdatesState, action: Action): TexPackageUpdatesState {
  switch (action.type) {
    case "check-started":
      return { ...state, checking: true };
    case "checked":
      return { ...state, report: action.report, checking: false, run: action.afterUpdate ? state.run : null };
    case "update-started":
      // A check still running answers for the packages before this update.
      return { ...state, checking: false, run: { progress: { stage: "authorizing", progress: 0 }, running: true, error: null } };
    case "update-progress":
      return state.run?.running ? { ...state, run: { ...state.run, progress: action.progress } } : state;
    case "update-finished":
      if (!state.run) return state;
      return {
        ...state,
        run: action.error === null
          ? { progress: { stage: "complete", progress: 1 }, running: false, error: null }
          : { ...state.run, running: false, error: action.error },
      };
  }
}

/**
 * The TeX doctor's package-update check and the one-click update. The check
 * asks the TeX Live repository, so the launch check never waits on it: the
 * doctor page runs it, and `useDailyTexPackageCheck` once a day in the
 * background. A finished update checks again, so the row reflects what is
 * left, and keeps its result until a later check; a check while an update
 * runs would only see the old packages.
 */
export function useTexPackageUpdates() {
  const [state, dispatch] = useReducer(reducer, IDLE);
  const checkGenerationRef = useRef(0);
  const updatingRef = useRef(false);

  const recheck = useCallback(async (afterUpdate: boolean): Promise<TexPackageUpdatesReport | null> => {
    if (updatingRef.current) return null;
    const generation = ++checkGenerationRef.current;
    dispatch({ type: "check-started" });
    const report = await invoke<TexPackageUpdatesReport | null>("check_tex_package_updates").then(
      (found) => found ?? null,
      (reason): TexPackageUpdatesReport => ({ managed: false, packages: [], error: toMessage(reason) }),
    );
    if (generation === checkGenerationRef.current) dispatch({ type: "checked", report, afterUpdate });
    return report;
  }, []);
  const check = useCallback(() => recheck(false), [recheck]);

  const update = useCallback(async () => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    checkGenerationRef.current += 1;
    dispatch({ type: "update-started" });
    const onProgress = new Channel<TexPackageUpdateProgress>();
    onProgress.onmessage = (progress) => dispatch({ type: "update-progress", progress });
    const error = await invoke("start_tex_package_update", { onProgress }).then(
      () => null,
      (reason: unknown) => toMessage(reason),
    );
    updatingRef.current = false;
    dispatch({ type: "update-finished", error });
    if (error === null) await recheck(true);
  }, [recheck]);

  return { ...state, check, update };
}

export type TexPackageUpdates = ReturnType<typeof useTexPackageUpdates>;

const LAST_CHECK_KEY = "lattice.tex-package-check.v1";
const DAY_MS = 24 * 60 * 60 * 1000;
/** After launch, so the check's tlmgr run never competes with opening a project. */
export const BACKGROUND_CHECK_DELAY_MS = 60_000;

function lastCheck(): number {
  try {
    return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The doctor's package check, run once a day after launch, so a TeX with
 * updates (lineno 5.7's misplaced line numbers, #726) shows them on Settings'
 * TeX doctor without the writer opening it first. Only a check the
 * repository answered counts: offline, it tries again on the next launch.
 */
export function useDailyTexPackageCheck(check: () => Promise<TexPackageUpdatesReport | null>) {
  useEffect(() => {
    // A perf-lab run measures the editor, not tlmgr.
    if (import.meta.env.VITE_PERF_LAB === "1" && window.__latticeLab) return;
    if (Date.now() - lastCheck() < DAY_MS) return;
    let disposed = false;
    const timer = globalThis.setTimeout(() => {
      void check().then((report) => {
        if (disposed || !report || report.error) return;
        try {
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        } catch {
          // Without storage it checks once per launch.
        }
      });
    }, BACKGROUND_CHECK_DELAY_MS);
    return () => {
      disposed = true;
      globalThis.clearTimeout(timer);
    };
  }, [check]);
}
