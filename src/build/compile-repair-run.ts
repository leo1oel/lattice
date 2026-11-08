/**
 * One Fix all run: save, start the repair task, poll it to a terminal status,
 * recompile. Loaded when the writer first clicks Fix all, so the startup
 * bundle carries only useCompileRepair's state (use-compile-repair.ts).
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import type { CompileDiagnostic } from "./compile-diagnostics";
import { cancelRepair, type CompileRepairState, type RepairOperation } from "./use-compile-repair";

/** What the Rust relay answers for a 404 on a started task: the running service does not know it (synara.rs). */
const TASK_UNKNOWN = "agent_task_unknown";

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function runCompileRepair({
  operation, owns, repairable, rootDocument, permissionMode, save, onComplete, setState, noteError, abandon,
}: {
  operation: RepairOperation;
  /** Whether `operation` still owns the window's repair. */
  owns: () => boolean;
  repairable: CompileDiagnostic[];
  rootDocument: string | undefined;
  permissionMode: string;
  save: () => Promise<boolean>;
  /** Read when the task completes, so it is the latest recompile. */
  onComplete: () => () => Promise<void>;
  setState: (state: CompileRepairState) => void;
  noteError: (error: unknown) => void;
  abandon: (operation: RepairOperation) => void;
}) {
  const running = (state: CompileRepairState) => setState(operation.stopping ? { ...state, stopping: true } : state);
  try {
    if (!(await save())) throw new Error(i18n._(msg`Save the project before repairing.`));
    if (!owns()) return;
    if (operation.cancelRequested) throw new Error(i18n._(msg`Repair cancelled.`));
    const result = await invoke<{ threadId: string }>("compile_repair", {
      action: "start", projectRoot: operation.root,
      rootDocument: rootDocument ?? null,
      runtimeMode: permissionMode,
      diagnostics: repairable.map(({ level, message, file, line }) => ({
        level, message, file: file ?? null, line: line ?? null,
      })),
    });
    const threadId = result?.threadId;
    if (!threadId) throw new Error(i18n._(msg`The repair service did not return a task.`));
    operation.threadId = threadId;
    if (!owns()) {
      await cancelRepair(operation.root, threadId);
      return;
    }
    running({ status: "running", threadId });
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
        // The service does not know the task: it is gone with the one that
        // ran it. Any other failure proves nothing about the provider.
        if (toMessage(error) === TASK_UNKNOWN) {
          abandon(operation);
          return;
        }
        noteError(error);
        await delay(2000);
        continue;
      }
      if (!owns()) return;
      if (progress.status === "failed") throw new Error(progress.message ?? i18n._(msg`Repair failed.`));
      if (progress.status === "completed") {
        operation.taskDone = true;
        setState({ status: "compiling", threadId });
        await onComplete()();
        if (owns()) setState({ status: "completed", threadId });
        return;
      }
      running({ ...progress, threadId });
      await delay(1000);
    }
  } catch (error) {
    // The relay currently returns plain strings, not structured conflict codes.
    // Match only a rejected start: a later failure must retain its diagnostics.
    const detail = toMessage(error);
    const message = !operation.threadId && detail === "The workspace already has an active writer."
      ? i18n._(msg`Repair has not started because another Agent task in this project is running or waiting for your response. Open Agent to finish or stop that task, then try Fix all again.`)
      : !operation.threadId && detail === "A compile repair is already running."
        ? i18n._(msg`Another compile repair is already starting for this project. Wait for it to finish before trying Fix all again.`)
        : String(error);
    if (owns()) setState({ status: "failed", threadId: operation.threadId, message });
  }
}
