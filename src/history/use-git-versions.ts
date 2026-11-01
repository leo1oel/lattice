/**
 * The project's git-backed versions: the log the history timeline lists, and
 * the actions on it — start tracking, save a version, restore a file or the
 * whole project. Restores are forward-only (the host commits the restored
 * tree as a new version), and each first saves the working tree as a version
 * of its own, so nothing typed since the last version is lost either.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import type { GitLogEntry, GitStatus } from "../app-types";
import { confirmAction, hostErrorMessage } from "../app-utils";
import { logAction } from "../telemetry/app-notify";
import { onProjectFilesChanged } from "../project/project-files-changed";
import { AUTO_COMMIT_MESSAGES } from "./version-messages";

export type GitVersionsPhase = "loading" | "unavailable" | "no-repo" | "ready" | "error";

/**
 * The last log read for each project, so the history drawer opens on its
 * versions at once and reads them again behind them, instead of drawing its
 * other rows first and the versions a round trip later between them.
 */
const lastLog = new Map<string, GitLogEntry[]>();

/** How many versions the log reads at first, and how many more each "older" asks for. */
const LOG_PAGE = 100;

export function useGitVersions(props: {
  projectRoot?: string;
  /** Called after any restore or manual save so the app can reload files. */
  onVersionsChanged?: () => void | Promise<void>;
  /** Called when the git backend itself is unreachable (`git_status` rejects). */
  onGitUnreachable?: () => void;
}) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<GitVersionsPhase>(() => (props.projectRoot && lastLog.has(props.projectRoot) ? "ready" : "loading"));
  const [entries, setEntries] = useState<GitLogEntry[]>(() => (props.projectRoot && lastLog.get(props.projectRoot)) || []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A full read may have left older versions out; reloads keep reading as far back as was asked.
  const [hasOlder, setHasOlder] = useState(() => entries.length >= LOG_PAGE);
  const logLimit = useRef(LOG_PAGE);

  const callbacksRef = useRef(props);
  useEffect(() => {
    callbacksRef.current = props;
  });
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const root = callbacksRef.current.projectRoot;
    setRefreshing(true);
    setError("");
    try {
      // Asked together: the log of a folder that is not a repository is empty.
      const limit = logLimit.current;
      const log = invoke<GitLogEntry[]>("git_log", { limit }).then(
        (entries) => ({ entries }),
        (reason: unknown) => ({ reason }),
      );
      const status = await invoke<GitStatus>("git_status");
      if (seq !== loadSeq.current) return;
      if (!status.available || !status.repository) {
        if (root) lastLog.delete(root);
        setPhase(status.available ? "no-repo" : "unavailable");
        return;
      }
      const read = await log;
      if (seq !== loadSeq.current) return;
      if ("entries" in read) {
        if (root) lastLog.set(root, read.entries);
        setEntries(read.entries);
        setHasOlder(read.entries.length >= limit);
      } else {
        setError(hostErrorMessage(read.reason));
      }
      setPhase("ready");
    } catch (reason) {
      if (seq !== loadSeq.current) return;
      // The `git_*` commands themselves are missing or broken (e.g. an older
      // backend build). Say so where the versions would be, and let the drawer
      // fall back to the Activity view so it stays useful.
      setError(hostErrorMessage(reason));
      setPhase("error");
      callbacksRef.current.onGitUnreachable?.();
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }, []);

  // Mount loads through a ref so the effect body holds no traceable synchronous setState call.
  const loadRef = useRef(load);
  useEffect(() => {
    const cancelLoad = () => { ++loadSeq.current; };
    logLimit.current = LOG_PAGE;
    void loadRef.current();
    const refresh = () => { void load(); };
    const stopListening = props.projectRoot ? onProjectFilesChanged(props.projectRoot, refresh) : () => undefined;
    // Git commits can also arrive while the app is unfocused or its watcher
    // is unavailable. Only poll while the timeline is mounted.
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      cancelLoad();
      stopListening();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load, props.projectRoot]);

  /** Run one logged action, then reload the timeline. */
  const runAction = async (label: string, detail: string | undefined, action: () => Promise<string>) => {
    setBusy(true);
    const trace = logAction(t`Versions`, label, detail);
    try {
      const outcome = await action();
      await load();
      trace.ok(outcome);
      return true;
    } catch (reason) {
      trace.fail(reason);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Commit the working tree before a restore overwrites it; a clean tree commits nothing. */
  const saveCurrentState = () => invoke<string | null>("git_auto_commit", { message: AUTO_COMMIT_MESSAGES.autoSaved, author: null });

  return {
    phase,
    entries,
    error,
    busy,
    refreshing,
    reload: load,
    hasOlder,
    /** Read the next page of older versions as well. */
    loadOlder: () => {
      logLimit.current += LOG_PAGE;
      return load();
    },
    enableTracking: () => runAction(t`Start tracking versions`, undefined, async () => {
      await invoke<GitStatus>("git_init");
      return t`Now tracking versions of this project.`;
    }),
    /** Save the working tree as a version named `label` (or the plain "Saved version"). */
    saveVersion: (label: string) => runAction(t`Save version`, label || undefined, async () => {
      const hash = await invoke<string | null>("git_auto_commit", { message: label || AUTO_COMMIT_MESSAGES.saved, author: null });
      if (hash) await callbacksRef.current.onVersionsChanged?.();
      return hash ? t`Version saved.` : t`No changes since the last version.`;
    }),
    restoreFile: async (hash: string, path: string) => {
      if (!await confirmAction(t`Restore ${path} to this version? The current state is saved as a version first.`)) return;
      await runAction(t`Restore file`, `${path} @ ${hash}`, async () => {
        await saveCurrentState();
        await invoke("git_restore_file", { rev: hash, path });
        await callbacksRef.current.onVersionsChanged?.();
        return t`Restored ${path}.`;
      });
    },
    restoreProject: async (hash: string) => {
      const warning = t`Restore the project to this version?

Nothing is lost: the current state is saved as a version first`;
      if (!await confirmAction(warning)) return;
      await runAction(t`Restore project`, hash, async () => {
        await saveCurrentState();
        await invoke<string>("git_restore_project", { rev: hash });
        await callbacksRef.current.onVersionsChanged?.();
        return t`Project restored.`;
      });
    },
  };
}

export type GitVersions = ReturnType<typeof useGitVersions>;
