import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import { diagnosticSeverity, type CompileDiagnostic } from "./compile-diagnostics";
import type { SynaraPermissionMode } from "../app/app-synara-embed";

export type CompileRepairState = {
  status: "starting" | "running" | "awaiting-approval" | "compiling" | "completed" | "failed";
  threadId?: string;
  message?: string;
  /** Cancel was asked for STOP_GRACE_MS ago and the task has not ended: the writer may unlock the editor anyway. */
  stopping?: boolean;
};

export type RepairOperation = {
  root: string;
  threadId?: string;
  cancelled: boolean;
  cancelRequested: boolean;
  stopping?: boolean;
  /** The task reported completed: only the recompile is left, and nothing can lose the task any more. */
  taskDone?: boolean;
  /**
   * The agent service the task started in (its `agentSession`), from the
   * start answer; undefined until then.
   */
  session?: string | null;
};

/** What the Rust relay answers for a 404 on a started task: the running service does not know it (synara/task_relay.rs). */
export const TASK_UNKNOWN = "agent_task_unknown";

/**
 * Only a terminal status releases the editor on its own, or the service
 * having restarted under the task or no longer knowing it: the task is gone
 * then. A transport failure or a slow Cancel does not prove the provider
 * stopped writing, so this long after Cancel the writer is offered an
 * explicit unlock instead.
 */
const STOP_GRACE_MS = 10_000;

export const cancelRepair = (projectRoot: string, threadId: string) =>
  invoke("compile_repair", { action: "cancel", projectRoot, threadId });

// Keep import expressions outside the hook: React Compiler cannot lower them.
// The run itself loads on the first Fix all (compile-repair-run.ts).
function loadCompileRepairRun() {
  return import("./compile-repair-run");
}

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
  /**
   * Stop following `operation`: release the editor, and ask the task to stop
   * in case it still runs. `message` says why; by default Lattice lost the task.
   */
  const abandon = useCallback((operation: RepairOperation, message?: string) => {
    if (operationRef.current !== operation || operation.cancelled || operation.taskDone) return;
    operation.cancelled = true;
    operationRef.current = null;
    if (operation.threadId) void cancelRepair(operation.root, operation.threadId).catch(() => undefined);
    setState({
      status: "failed",
      threadId: operation.threadId,
      message: message
        ?? t`Lattice lost track of the repair task, so the editor is writable again. Open Agent to see how far the repair got.`,
    });
  }, [t]);

  /** Ask the task to stop. A service that no longer knows it has lost it. */
  const requestCancel = useCallback(async (operation: RepairOperation) => {
    if (!operation.threadId) return;
    await cancelRepair(operation.root, operation.threadId).catch((error) => {
      if (operationRef.current !== operation || operation.cancelled) return;
      if (toMessage(error) === TASK_UNKNOWN) abandon(operation);
      else noteError(error);
    });
  }, [abandon, noteError]);

  const { agentSession } = options.agent;
  const lastSessionRef = useRef(agentSession);
  useEffect(() => {
    const previous = lastSessionRef.current;
    lastSessionRef.current = agentSession;
    // Only the task's own service going away loses it. The window catching
    // up to that service (X, then null, then the task's Y) is the restart
    // the start itself may have caused.
    const operation = operationRef.current;
    if (operation && operation.session !== undefined && previous === operation.session && agentSession !== previous) {
      abandon(operation);
    }
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
    const operation: RepairOperation = { root: current.projectRoot, cancelled: false, cancelRequested: false };
    operationRef.current = operation;
    const owns = () => operationRef.current === operation
      && !operation.cancelled && optionsRef.current.projectRoot === operation.root;
    setState({ status: "starting" });
    await loadCompileRepairRun().then(({ runCompileRepair }) => runCompileRepair({
      operation, owns, repairable, rootDocument: current.rootDocument, permissionMode: current.agent.permissionMode,
      save: current.save, onComplete: () => optionsRef.current.onComplete, setState, noteError, abandon, requestCancel,
    })).catch((error: unknown) => {
      if (owns()) setState({ status: "failed", message: String(error) });
    }).finally(() => {
      if (operationRef.current === operation) operationRef.current = null;
    });
  }, [abandon, noteError, optionsRef, requestCancel]);

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
    await requestCancel(operation);
  }, [requestCancel]);

  /** The writer's explicit release of a task that has not stopped since Cancel. */
  const unlock = useCallback(() => {
    const operation = operationRef.current;
    if (operation) abandon(operation, t`Editor unlocked while the repair may still be running. Open Agent to see how far it got.`);
  }, [abandon, t]);

  const busy = state !== null && !["completed", "failed"].includes(state.status);
  // One object while its members hold still: a new one each render rebuilt
  // the diagnostics panel App builds from it on every keystroke.
  return useMemo(() => ({ state, busy, start, cancel, unlock }), [busy, cancel, start, state, unlock]);
}
