import { useCallback, useRef, type RefObject } from "react";
import type { OpenFileOptions } from "../app-types";
import { useLatestRef } from "../hooks/use-latest-ref";
import { showingErrors } from "./notify";
import type { UpdateCanvasRequest } from "./use-canvas-requests";

export type BuildErrorFixDeps = {
  /** A check that turns false once the project open now is no longer the one open. */
  captureProjectScope: () => () => boolean;
  openFile: (path: string, options?: OpenFileOptions) => Promise<void>;
  /** The file in the text editor, and an asset covering it. */
  fileRef: RefObject<string>;
  assetRef: RefObject<unknown>;
  updateCanvasRequest: UpdateCanvasRequest;
  /** Publish deferred visual edits; false when they cannot be. */
  flush: () => boolean;
  save: () => Promise<boolean>;
  compile: () => Promise<unknown>;
};

/** The fix waiting for the canvas, and the project it was asked in. */
type PendingFix = { id: string; ownsProject: () => boolean };

/**
 * A failed build's suggested fix (compile-explain.ts): the replacement lands
 * in the editor as a transaction, so ⌘Z takes it back like typing, and once
 * the canvas has applied it the file is saved and built again. A token that
 * is no longer on its line changes nothing, and the build reports what is.
 *
 * The fix names its file by a project-relative path, which the next project
 * may have too, so it belongs to the project it was asked in: opening the file
 * can outlive that project (the open then quietly gives up), and so can the
 * canvas's answer. It reaches the canvas only once that same file is open in
 * that same project, and is saved and built only while the project still is;
 * `reset` withdraws it when the project changes.
 */
export function useBuildErrorFix(deps: BuildErrorFixDeps) {
  const depsRef = useLatestRef(deps);
  const pendingRef = useRef<PendingFix | null>(null);

  const replaceToken = useCallback(async (path: string, line: number, token: string, replacement: string) => {
    const ownsProject = depsRef.current.captureProjectScope();
    await showingErrors(async () => {
      await depsRef.current.openFile(path, { line });
      // openFile resolves without opening when a newer choice or another
      // project superseded it; only the file it was asked for may change.
      const { fileRef, assetRef, updateCanvasRequest } = depsRef.current;
      if (!ownsProject() || fileRef.current !== path || assetRef.current) return;
      const id = crypto.randomUUID();
      pendingRef.current = { id, ownsProject };
      updateCanvasRequest("replace", { path, line, token, replacement, id });
    });
  }, [depsRef]);

  /** The canvas answered request `id`: save and build if it was the pending fix. */
  const settled = useCallback((id: string) => {
    const pending = pendingRef.current;
    if (pending?.id !== id) return;
    pendingRef.current = null;
    const { flush, save, compile } = depsRef.current;
    void (async () => {
      if (pending.ownsProject() && flush() && await save() && pending.ownsProject()) await compile();
    })();
  }, [depsRef]);

  /** Withdraw a fix not yet applied: its project is closing. */
  const reset = useCallback(() => {
    pendingRef.current = null;
    depsRef.current.updateCanvasRequest("replace", null);
  }, [depsRef]);

  return { replaceToken, settled, reset };
}
