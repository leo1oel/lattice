import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import type { CompileDiagnostic } from "./compile-diagnostics";

export type CompileRepairState = {
  status: "starting" | "running" | "awaiting-approval" | "compiling" | "completed" | "failed";
  threadId?: string;
  message?: string;
};

/** A user-initiated repair is separate from the visible agent conversation. */
export function useCompileRepair(options: {
  projectRoot: string | undefined;
  rootDocument: string | undefined;
  enabled: boolean;
  save: () => Promise<boolean>;
  onComplete: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<CompileRepairState | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const operationRef = useRef<{ root: string; threadId?: string; cancelled: boolean; cancelRequested: boolean } | null>(null);

  useEffect(() => {
    setState(null);
    return () => {
      const operation = operationRef.current;
      if (!operation) return;
      operation.cancelled = true;
      operationRef.current = null;
      if (operation.threadId) {
        void invoke("compile_repair", {
          action: "cancel", projectRoot: operation.root, threadId: operation.threadId,
        }).catch(() => { /* The reviewable task remains in Agent if the service disconnected. */ });
      }
    };
  }, [options.projectRoot]);

  const start = useCallback(async (diagnostic: CompileDiagnostic) => {
    const current = optionsRef.current;
    if (!current.enabled || !current.projectRoot || operationRef.current) return;
    const operation = { root: current.projectRoot, cancelled: false, cancelRequested: false, threadId: undefined as string | undefined };
    operationRef.current = operation;
    const owns = () => operationRef.current === operation
      && !operation.cancelled && optionsRef.current.projectRoot === operation.root;
    setState({ status: "starting" });
    try {
      if (!(await current.save())) throw new Error(t`Save the project before repairing.`);
      if (!owns()) return;
      if (operation.cancelRequested) throw new Error(t`Repair cancelled.`);
      const result = await invoke<{ threadId: string }>("compile_repair", {
        action: "start", projectRoot: operation.root,
        rootDocument: current.rootDocument ?? null,
        diagnostic: { ...diagnostic, file: diagnostic.file ?? null, line: diagnostic.line ?? null },
      });
      if (!result?.threadId) throw new Error(t`The repair service did not return a task.`);
      operation.threadId = result.threadId;
      if (!owns()) {
        await invoke("compile_repair", { action: "cancel", projectRoot: operation.root, threadId: result.threadId });
        return;
      }
      setState({ status: "running", threadId: result.threadId });
      if (operation.cancelRequested) {
        await invoke("compile_repair", { action: "cancel", projectRoot: operation.root, threadId: result.threadId })
          .catch((error) => { if (owns()) setState((previous) => previous && ({ ...previous, message: String(error) })); });
      }
      while (owns()) {
        let progress: CompileRepairState;
        try {
          progress = await invoke<CompileRepairState>("compile_repair", {
            action: "status", projectRoot: operation.root, threadId: result.threadId,
          });
        } catch (error) {
          // A failed status request says nothing about the writer's lifetime.
          if (owns()) setState((previous) => previous && ({ ...previous, message: String(error) }));
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          continue;
        }
        if (!owns()) return;
        if (progress.status === "failed") throw new Error(progress.message ?? t`Repair failed.`);
        if (progress.status === "completed") {
          setState({ status: "compiling", threadId: result.threadId });
          await optionsRef.current.onComplete();
          if (owns()) setState({ status: "completed", threadId: result.threadId });
          return;
        }
        setState({ ...progress, threadId: result.threadId });
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (owns()) setState({ status: "failed", threadId: operation.threadId, message: String(error) });
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  }, [t]);

  const cancel = useCallback(async () => {
    const operation = operationRef.current;
    if (!operation) return;
    operation.cancelRequested = true;
    // Retain polling until the interrupt is acknowledged. A transport failure
    // must not pretend that the provider has stopped writing.
    if (operation.threadId) {
      try {
        await invoke("compile_repair", { action: "cancel", projectRoot: operation.root, threadId: operation.threadId });
        // The command is accepted before the provider has necessarily stopped.
        // Only a terminal status releases the editor and permits another fix.
        return;
      } catch (error) {
        if (operationRef.current === operation) setState((previous) => previous && ({ ...previous, message: String(error) }));
        return;
      }
    }
  }, []);

  const busy = state !== null && !["completed", "failed"].includes(state.status);
  return { state, busy, start, cancel };
}
