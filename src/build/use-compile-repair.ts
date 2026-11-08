import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { diagnosticSeverity, type CompileDiagnostic } from "./compile-diagnostics";
import type { SynaraPermissionMode } from "../app/app-synara-embed";
import { toMessage } from "../app-utils";

export type CompileRepairState = {
  status: "starting" | "running" | "awaiting-approval" | "compiling" | "completed" | "failed";
  threadId?: string;
  message?: string;
  /** Cancel was asked for STOP_GRACE_MS ago and the task has not ended: the writer may unlock the editor anyway. */
  stopping?: boolean;
};

type RepairOperation = {
  root: string;
  threadId?: string;
  cancelled: boolean;
  cancelRequested: boolean;
  stopping?: boolean;
  /** The task reported completed: only the recompile is left, and nothing can lose the task any more. */
  taskDone?: boolean;
  /** The agent service the task runs in (`agentSession`), once known. */
  session: string | null;
};

/**
 * Only a terminal status releases the editor on its own, or the service
 * having restarted under the task or no longer having its route: the task is
 * gone then. A transport failure or a slow Cancel does not prove the provider
 * stopped writing, so this long after Cancel the writer is offered an
 * explicit unlock instead.
 */
const STOP_GRACE_MS = 10_000;
/** What the Rust relay answers for a path the running service does not have (synara.rs). */
const ROUTE_UNAVAILABLE = "agent_route_unavailable";

const cancelRepair = (projectRoot: string, threadId: string) =>
  invoke("compile_repair", { action: "cancel", projectRoot, threadId });
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** A user-initiated repair is separate from the visible agent conversation. */
export function useCompileRepair(options: {
  projectRoot: string | undefined;
  rootDocument: string | undefined;
  /**
   * The agent panel: its permission mode, which the repair runs under, and
   * `agentSession`, the running agent service's identity (its auth token
   * while ready, which each launch makes anew; null while unknown). A
   * different session means the service restarted, and the repair task it
   * ran is gone with it.
   */
  agent: { permissionMode: SynaraPermissionMode; agentSession: string | null };
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
  /** Stop following `operation`: release the editor, and ask the task to stop in case it still runs. */
  const abandon = useCallback((operation: RepairOperation) => {
    if (operationRef.current !== operation || operation.cancelled || operation.taskDone) return;
    operation.cancelled = true;
    operationRef.current = null;
    if (operation.threadId) void cancelRepair(operation.root, operation.threadId).catch(() => undefined);
    setState({
      status: "failed",
      threadId: operation.threadId,
      message: t`Lattice lost track of the repair task, so the editor is writable again. Open Agent to see how far the repair got.`,
    });
  }, [t]);

  const { agentSession } = options.agent;
  useEffect(() => {
    const operation = operationRef.current;
    if (!operation) return;
    if (operation.session === null) operation.session = agentSession;
    else if (agentSession !== operation.session) abandon(operation);
  }, [abandon, agentSession]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks-js/set-state-in-effect -- a different project starts without the previous project's repair.
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
    const operation: RepairOperation = {
      root: current.projectRoot, cancelled: false, cancelRequested: false, session: current.agent.agentSession,
    };
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
        runtimeMode: current.agent.permissionMode,
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
      setState({ status: "running", threadId, ...(operation.stopping && { stopping: true }) });
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
          if (!owns()) return;
          if (toMessage(error) === ROUTE_UNAVAILABLE) {
            abandon(operation);
            return;
          }
          noteError(error);
          await delay(2000);
          continue;
        }
        if (!owns()) return;
        if (progress.status === "failed") throw new Error(progress.message ?? t`Repair failed.`);
        if (progress.status === "completed") {
          operation.taskDone = true;
          setState({ status: "compiling", threadId });
          await optionsRef.current.onComplete();
          if (owns()) setState({ status: "completed", threadId });
          return;
        }
        setState({ ...progress, threadId, ...(operation.stopping && { stopping: true }) });
        await delay(1000);
      }
    } catch (error) {
      // The relay currently returns plain strings, not structured conflict codes.
      // Match only a rejected start: a later failure must retain its diagnostics.
      const detail = toMessage(error);
      const message = !operation.threadId && detail === "The workspace already has an active writer."
        ? t`Repair has not started because another Agent task in this project is running or waiting for your response. Open Agent to finish or stop that task, then try Fix all again.`
        : !operation.threadId && detail === "A compile repair is already running."
          ? t`Another compile repair is already starting for this project. Wait for it to finish before trying Fix all again.`
          : String(error);
      if (owns()) setState({ status: "failed", threadId: operation.threadId, message });
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  }, [abandon, noteError, optionsRef, t]);

  const cancel = useCallback(async () => {
    const operation = operationRef.current;
    if (!operation) return;
    // The command is accepted before the provider has necessarily stopped, so
    // polling continues until a terminal status releases the editor and
    // permits another fix. A task that does not get there in STOP_GRACE_MS
    // (or a service Cancel cannot reach) is left to the writer's unlock.
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      window.setTimeout(() => {
        if (operationRef.current !== operation || operation.cancelled) return;
        operation.stopping = true;
        setState((previous) => previous && previous.status !== "compiling" ? { ...previous, stopping: true } : previous);
      }, STOP_GRACE_MS);
    }
    if (!operation.threadId) return;
    await cancelRepair(operation.root, operation.threadId).catch((error) => {
      if (operationRef.current === operation && !operation.cancelled) noteError(error);
    });
  }, [noteError]);

  /** The writer's explicit release of a task that has not stopped since Cancel. */
  const unlock = useCallback(() => {
    const operation = operationRef.current;
    if (operation) abandon(operation);
  }, [abandon]);

  const busy = state !== null && !["completed", "failed"].includes(state.status);
  // Memoized by hand: the React Compiler skips this hook (its try/finally),
  // and a new object each render rebuilt the diagnostics panel App builds
  // from it on every keystroke.
  return useMemo(() => ({ state, busy, start, cancel, unlock }), [busy, cancel, start, state, unlock]);
}
