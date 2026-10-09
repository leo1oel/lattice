import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import {
  LATTICE_AGENT_COMPILE_RESULT,
  parseAgentCompileResultMessage,
  synaraProjectRelativeFilePath,
  type AgentCheckpointHistoryEntry,
  type AgentCompileResultMessage,
  type AgentProjectHistorySnapshot,
} from "../agent/synara-runtime";
import type { HistoryItem } from "../history/history-drawer";
import type { BuildPreferences } from "../settings/app-settings";
import { persistSynaraThread } from "./app-synara-embed";
import { clearTimer, restartTimer } from "./effect-helpers";

export type AgentCompileAssociation = { threadId: string; turnId: string; checkpointRef: string };

const entryKey = (entry: AgentCheckpointHistoryEntry) => `${entry.threadId}\u0000${entry.id}`;
const isBuildInputPath = (path: string) => !path.startsWith(".research/") && !path.startsWith(".git/");
const touchesBuild = (entry: AgentCheckpointHistoryEntry) => entry.files.some((file) => isBuildInputPath(file.path));

/**
 * Agent turns edit files on disk without passing through the editor, so the
 * dirty-buffer autosave path never rebuilds the PDF for them. This watches the
 * checkpoint history Synara streams, rebuilds once fresh work goes quiet, and
 * reports each build back to the turns that caused it. It also keeps each
 * thread's checkpoints for the history drawer.
 */
export function useAgentCheckpoints({ project, projectRef, autoBuildModeRef, compileRef, onExternalEdits, postMessage }: {
  project: ProjectSnapshot | null;
  projectRef: { readonly current: ProjectSnapshot | null };
  /** Read inside the Synara message handler, which outlives any single render. */
  autoBuildModeRef: { readonly current: BuildPreferences["autoBuildMode"] };
  compileRef: { readonly current: (force?: boolean, sound?: boolean, options?: { consumeAgentAssociations?: boolean }) => Promise<void> };
  onExternalEdits: { readonly current: (paths: readonly string[]) => void };
  postMessage: (message: object) => void;
}) {
  const { t } = useLingui();
  const [historyByThread, setHistoryByThread] = useState<Record<string, AgentCheckpointHistoryEntry[]>>({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Snapshots re-arrive on every thread update (and stream while a turn is
  // still editing), so a rebuild must only follow entries whose files actually
  // changed — and never the first snapshot of a thread, which replays history.
  const entriesRef = useRef(new Map<string, AgentCheckpointHistoryEntry>());
  const primedThreadsRef = useRef(new Set<string>());
  const pendingCompilesRef = useRef(new Map<string, AgentCompileAssociation>());
  const buildTimerRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    entriesRef.current.clear();
    primedThreadsRef.current.clear();
    pendingCompilesRef.current.clear();
    clearTimer(buildTimerRef);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks-js/set-state-in-effect -- another project's threads must not survive the switch
    setHistoryByThread({});
    setActiveThreadId(null);
  }, [project?.root]);

  /** Associations for the checkpoints the next build will cover. */
  const takePendingCompiles = useCallback(() => {
    const associations = [...pendingCompilesRef.current.values()];
    pendingCompilesRef.current.clear();
    return associations;
  }, []);

  const reportCompiles = useCallback((associations: AgentCompileAssociation[], result: BuildResult | null) => {
    const diagnostics = result?.diagnostics ?? [];
    for (const association of associations) {
      const message = parseAgentCompileResultMessage({
        type: LATTICE_AGENT_COMPILE_RESULT,
        version: 1,
        ...association,
        compiledAt: new Date().toISOString(),
        success: result?.success ?? false,
        durationMs: result?.durationMs ?? null,
        rootDocument: result?.rootDocument
          ? synaraProjectRelativeFilePath(result.rootDocument, projectRef.current?.root)
          : null,
        diagnostics: {
          errors: diagnostics.filter((item) => item.level === "error").length,
          warnings: diagnostics.filter((item) => item.level === "warning").length,
        },
      } satisfies AgentCompileResultMessage);
      if (message) postMessage(message);
    }
  }, [postMessage, projectRef]);

  const handleSnapshot = useCallback((snapshot: AgentProjectHistorySnapshot) => {
    const threadId = snapshot.activeThreadId;
    const root = projectRef.current?.root;
    if (root) persistSynaraThread(root, threadId);
    setHistoryByThread((current) => ({ ...current, [threadId]: snapshot.entries }));
    setActiveThreadId(threadId);
    const previousEntries = entriesRef.current;
    const incomingKeys = new Set(snapshot.entries.map(entryKey));
    const removedEntries: AgentCheckpointHistoryEntry[] = [];
    for (const [key, entry] of previousEntries) {
      if (entry.threadId !== threadId || incomingKeys.has(key)) continue;
      previousEntries.delete(key);
      pendingCompilesRef.current.delete(key);
      removedEntries.push(entry);
    }
    const changedEntries = snapshot.entries.filter((entry) => {
      const previous = previousEntries.get(entryKey(entry));
      previousEntries.set(entryKey(entry), entry);
      // Equal line counts do not imply equal content. The completion
      // timestamp/ref also move when a checkpoint is regenerated.
      return previous?.timestamp !== entry.timestamp
        || previous.checkpointRef !== entry.checkpointRef
        || JSON.stringify(previous.files) !== JSON.stringify(entry.files);
    });
    if (!primedThreadsRef.current.has(threadId)) {
      primedThreadsRef.current.add(threadId);
      return;
    }
    const buildEntries = changedEntries.filter(touchesBuild);
    // Undo clears a turn's diff, so Synara omits it from the next history
    // snapshot. It is disk work too, even when no new entry arrives.
    const restoredEntries = removedEntries.filter(touchesBuild);
    onExternalEdits.current([...new Set(
      [...buildEntries, ...restoredEntries].flatMap((entry) => entry.files.map((file) => file.path)).filter(isBuildInputPath),
    )]);
    const restored = restoredEntries.length > 0;
    if (!restored && (!buildEntries.length || autoBuildModeRef.current !== "automatic")) return;
    for (const entry of buildEntries) {
      pendingCompilesRef.current.set(entryKey(entry), {
        threadId: entry.threadId,
        turnId: entry.turnId,
        checkpointRef: entry.checkpointRef,
      });
    }
    restartTimer(buildTimerRef, restored ? 0 : 1_500, () => {
      if (projectRef.current?.root !== root) return;
      void compileRef.current(false, false, { consumeAgentAssociations: true });
    });
  }, [autoBuildModeRef, compileRef, onExternalEdits, projectRef]);

  /** Each thread's checkpoints as history-drawer items; only the open thread can restore. */
  const historyItems = useMemo<HistoryItem[]>(() => Object.values(historyByThread).flatMap((entries) => (
    entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      timestamp: entry.timestamp,
      files: entry.files.map((file) => file.path),
      actor: "agent",
      kind: "agent-checkpoint",
      source: "agent-checkpoint",
      threadId: entry.threadId,
      threadTitle: entry.threadTitle,
      checkpointRef: entry.checkpointRef,
      turnCount: entry.turnCount,
      fileSummaries: entry.files,
      restoreAvailable: entry.threadId === activeThreadId,
      restoreUnavailableReason: entry.threadId === activeThreadId
        ? null
        : t`Open this Agent task before restoring its files`,
    }))
  )), [activeThreadId, historyByThread, t]);

  return { reset, takePendingCompiles, reportCompiles, handleSnapshot, historyItems };
}
