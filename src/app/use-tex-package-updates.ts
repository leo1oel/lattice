import { useCallback, useReducer, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import type { TexPackageUpdateProgress, TexPackageUpdatesReport } from "../build/tex-package-updates";

type TexPackageUpdatesState = {
  /** The last check; null before one finishes, or without a tlmgr to ask. */
  report: TexPackageUpdatesReport | null;
  checking: boolean;
  /** The update: present while it runs and after it ends, until the next one. */
  run: {
    progress: TexPackageUpdateProgress;
    running: boolean;
    /** Why it failed; null while running and after it succeeded. */
    error: string | null;
  } | null;
};

type Action =
  | { type: "check-started" }
  | { type: "checked"; report: TexPackageUpdatesReport | null }
  | { type: "update-started" }
  | { type: "update-progress"; progress: TexPackageUpdateProgress }
  | { type: "update-finished"; error: string | null };

const IDLE: TexPackageUpdatesState = { report: null, checking: false, run: null };

function reducer(state: TexPackageUpdatesState, action: Action): TexPackageUpdatesState {
  switch (action.type) {
    case "check-started":
      return { ...state, checking: true };
    case "checked":
      return { ...state, report: action.report, checking: false };
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
 * asks the TeX Live repository, so only the doctor page runs it, never the
 * launch check. A finished update checks again, so the row reflects what is
 * left; a check while an update runs would only see the old packages.
 */
export function useTexPackageUpdates() {
  const [state, dispatch] = useReducer(reducer, IDLE);
  const checkGenerationRef = useRef(0);
  const updatingRef = useRef(false);

  const check = useCallback(async () => {
    if (updatingRef.current) return;
    const generation = ++checkGenerationRef.current;
    dispatch({ type: "check-started" });
    const report = await invoke<TexPackageUpdatesReport | null>("check_tex_package_updates").then(
      (found) => found ?? null,
      (reason): TexPackageUpdatesReport => ({ managed: false, packages: [], error: toMessage(reason) }),
    );
    if (generation === checkGenerationRef.current) dispatch({ type: "checked", report });
  }, []);

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
    if (error === null) await check();
  }, [check]);

  return { ...state, check, update };
}

export type TexPackageUpdates = ReturnType<typeof useTexPackageUpdates>;
