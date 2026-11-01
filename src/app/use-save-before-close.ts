import { useEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { useLatestRef } from "../hooks/use-latest-ref";
import { registerCrashEdits } from "../telemetry/crash-save";
import { showWarning } from "./notify";
import { disposeWhenSettled } from "./effect-helpers";
import { listenInThisWindow } from "./window-events";

/** The backend asks this window to save before it closes or Lattice quits (src-tauri/src/save_before_close.rs). */
export const SAVE_BEFORE_CLOSE_EVENT = "save-before-close";

type Edits = {
  flush: () => boolean;
  save: () => Promise<boolean>;
  hasUnsavedEdits: () => boolean;
};

/**
 * Write the open edits before this page goes away, whichever way it goes.
 *
 * Autosave waits for a pause in typing (and for an open completion menu to
 * close), so whatever was typed in the last second or so exists only in this
 * page. A desktop window closing, ⌘Q, or a reload used to take it with them.
 *
 * - Closing the window or quitting: the backend holds the close until this
 *   page answers its request (or a few seconds pass). A save that fails keeps
 *   the window open once, with a warning; closing again closes anyway.
 * - A reload, and a browser tab closing: the save starts as the page goes, and
 *   a browser tab also asks the writer to stay while it runs.
 * - A render error: the error boundary that catches it starts the save
 *   (telemetry/crash-save.ts), and the crash page's Restart waits for it.
 */
export function useSaveBeforeClose({ browserHosted, ...edits }: Edits & { browserHosted: boolean }) {
  const { t } = useLingui();
  const editsRef = useLatestRef(edits);
  /** The last close found an edit it could not save: the next close goes ahead anyway. */
  const closeAnywayRef = useRef(false);
  const unsavedWarning = t`An edit could not be saved, so the window stayed open. Close or quit again to leave without it.`;
  const warningRef = useLatestRef(unsavedWarning);

  useEffect(() => {
    if (browserHosted) return;
    const answer = async (id: number) => {
      const { flush, save } = editsRef.current;
      // An unfinished IME composition cannot be published; everything else is.
      flush();
      const saved = await save().catch(() => false);
      const closing = saved || closeAnywayRef.current;
      closeAnywayRef.current = !closing;
      if (!closing) showWarning(warningRef.current);
      await invoke("finish_save_before_close", { id, saved: closing });
    };
    const listening = listenInThisWindow<number>(SAVE_BEFORE_CLOSE_EVENT, (event) => {
      void answer(event.payload).catch(() => undefined);
    });
    let disposed = false;
    // Only once the request can arrive: a window that asked before would wait
    // out the backend's timeout for an answer nobody sends.
    void listening.then(() => disposed ? undefined : invoke("enable_save_before_close")).catch(() => undefined);
    const unlisten = disposeWhenSettled(listening);
    return () => {
      disposed = true;
      unlisten();
      // Nothing here answers any more (the crash page replaced App, whose
      // crash save already ran): a quit or restart must not wait on it.
      void invoke("disable_save_before_close").catch(() => undefined);
    };
  }, [browserHosted, editsRef, warningRef]);

  useEffect(() => {
    const saveLeavingPage = (event?: BeforeUnloadEvent) => {
      const { flush, save, hasUnsavedEdits } = editsRef.current;
      flush();
      if (!hasUnsavedEdits()) return;
      // Sending the invoke begins synchronously before the page is discarded.
      void save();
      // In a browser tab, the confirmation keeps a just-typed buffer alive long
      // enough for the loopback write to finish. A desktop window shows no such
      // prompt; its close and quit already waited for the save above.
      if (event && browserHosted) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const pageHide = () => saveLeavingPage();
    window.addEventListener("beforeunload", saveLeavingPage);
    window.addEventListener("pagehide", pageHide);
    // A render error is the page going away too, or the panel holding the
    // editor (see telemetry/crash-save.ts). In this effect rather than its own:
    // App renders this hook on startup, and each hook there is counted.
    const unregisterCrash = registerCrashEdits({
      flush: () => editsRef.current.flush(),
      save: () => editsRef.current.save(),
    });
    return () => {
      window.removeEventListener("beforeunload", saveLeavingPage);
      window.removeEventListener("pagehide", pageHide);
      unregisterCrash();
    };
  }, [browserHosted, editsRef]);
}
