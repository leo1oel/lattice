import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { diagnosticSeverity, type CompileDiagnostic } from "./compile-diagnostics";
import type { SynaraPermissionMode } from "../app/app-synara-embed";

export type CompileRepairState = {
  status: "starting" | "running" | "awaiting-approval" | "compiling" | "completed" | "failed";
  threadId?: string;
  message?: string;
};

type RepairOperation = { root: string; threadId?: string; cancelled: boolean; cancelRequested: boolean };

const cancelRepair = (projectRoot: string, threadId: string) =>
  invoke("compile_repair", { action: "cancel", projectRoot, threadId });
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** A user-initiated repair is separate from the visible agent conversation. */
export function useCompileRepair(options: {
  projectRoot: string | undefined;
  rootDocument: string | undefined;
  runtimeMode: SynaraPermissionMode;
  enabled: boolean;
  save: () => Promise<boolean>;
  onComplete: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<CompileRepairState | null>(null);
  const optionsRef = useLatestRef(options);
  const operationRef = useRef<RepairOperation | null>(null);
  // Keep the current phase: a transport error says nothing about the writer's lifetime.
  const noteError = useCallback((error: unknown) => {
    setState((previous) => previous && ({ ...previous, message: String(error) }));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a different project starts without the previous project's repair.
    setState(null);
    return () => {
      const operation = operationRef.current;
      if (!operation) return;
      operation.cancelled = true;
      operationRef.current = null;
      if (operation.threadId) {
        void cancelRepair(operation.root, operation.threadId)
          .catch(() => { /* The reviewable task remains in Agent if the service disconnected. */ });
      }
    };
  }, [options.projectRoot]);

  const start = useCallback(async (diagnostics: CompileDiagnostic[]) => {
    const current = optionsRef.current;
    const repairable = diagnostics.filter((item) => diagnosticSeverity(item.level) !== "info");
    if (!current.enabled || !current.projectRoot || operationRef.current || !repairable.length) return;
    const operation: RepairOperation = { root: current.projectRoot, cancelled: false, cancelRequested: false };
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
        runtimeMode: current.runtimeMode,
        diagnostics: repairable.map(({ level, message, file, line }) => ({
          level, message, file: file ?? null, line: line ?? null,
        })),
      });
      const threadId = result?.threadId;
      if (!threadId) throw new Error(t`The repair service did not return a task.`);
      operation.threadId = threadId;
      if (!owns()) {
        await cancelRepair(operation.root, threadId);
        return;
      }
      setState({ status: "running", threadId });
      if (operation.cancelRequested) {
        await cancelRepair(operation.root, threadId).catch((error) => { if (owns()) noteError(error); });
      }
      while (owns()) {
        let progress: CompileRepairState;
        try {
          progress = await invoke<CompileRepairState>("compile_repair", {
            action: "status", projectRoot: operation.root, threadId,
          });
        } catch (error) {
          if (owns()) noteError(error);
          await delay(2000);
          continue;
        }
        if (!owns()) return;
        if (progress.status === "failed") throw new Error(progress.message ?? t`Repair failed.`);
        if (progress.status === "completed") {
          setState({ status: "compiling", threadId });
          await optionsRef.current.onComplete();
          if (owns()) setState({ status: "completed", threadId });
          return;
        }
        setState({ ...progress, threadId });
        await delay(1000);
      }
    } catch (error) {
      // The relay currently returns plain strings, not structured conflict codes.
      // Match only a rejected start: a later failure must retain its diagnostics.
      const detail = error instanceof Error ? error.message : String(error);
      const message = !operation.threadId && detail === "The workspace already has an active writer."
        ? t`Repair has not started because another Agent task in this project is running or waiting for your response. Open Agent to finish or stop that task, then try Fix all again.`
        : !operation.threadId && detail === "A compile repair is already running."
          ? t`Another compile repair is already starting for this project. Wait for it to finish before trying Fix all again.`
          : String(error);
      if (owns()) setState({ status: "failed", threadId: operation.threadId, message });
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  }, [noteError, optionsRef, t]);

  const cancel = useCallback(async () => {
    const operation = operationRef.current;
    if (!operation) return;
    operation.cancelRequested = true;
    // The command is accepted before the provider has necessarily stopped, so
    // polling continues: only a terminal status releases the editor and permits
    // another fix. A transport failure must not pretend the provider stopped.
    if (!operation.threadId) return;
    try {
      await cancelRepair(operation.root, operation.threadId);
    } catch (error) {
      if (operationRef.current === operation) noteError(error);
    }
  }, [noteError]);

  const busy = state !== null && !["completed", "failed"].includes(state.status);
  return { state, busy, start, cancel };
}
