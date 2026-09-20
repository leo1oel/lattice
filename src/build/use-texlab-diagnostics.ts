import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_DIAGNOSTICS, type CompileDiagnostic } from "./compile-diagnostics";

export function useTexlabDiagnostics(
  projectRoot: string | undefined,
  path: string,
  text: string,
  build: object | null,
): CompileDiagnostic[] {
  // Identity changes even when returning to a previously visited file/text.
  const scope = useMemo(() => ({ projectRoot, path, text, build }), [projectRoot, path, text, build]);
  const syncQueue = useRef(Promise.resolve());
  const [result, setResult] = useState<{
    scope: typeof scope;
    diagnostics: CompileDiagnostic[];
  } | null>(null);
  useEffect(() => {
    const { projectRoot, path, text } = scope;
    if (!projectRoot || !path.endsWith(".tex")) return;
    const requestId = crypto.randomUUID();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      // Install the listener before syncing: diagnostics may arrive before the
      // command resolves, and later build/log updates arrive without any edits.
      void listen<{ requestId: string; diagnostics: CompileDiagnostic[] }>(
        "texlab-diagnostics",
        ({ payload }) => {
          if (!disposed && payload.requestId === requestId) {
            setResult({ scope, diagnostics: payload.diagnostics });
          }
        },
      ).then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        // Cold starts can overlap later edits. Serialize subscriptions so an
        // older IPC task cannot replace the backend's newer subscription.
        const sync = syncQueue.current.catch(() => {}).then(async () => {
          if (!disposed) await invoke("texlab_diagnostics", { projectRoot, path, text, requestId });
        });
        syncQueue.current = sync;
        await sync;
      }).catch(() => {
        if (!disposed) setResult(null);
      });
    }, 700);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
    // A completed build must resync even when neither source nor success changed.
  }, [scope]);
  // Hide stale locations in the edit's own render, rather than clearing state
  // in an effect and causing another whole-App render on every keystroke.
  return result?.scope === scope ? result.diagnostics : EMPTY_DIAGNOSTICS;
}
