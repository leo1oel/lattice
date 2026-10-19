/**
 * The rtex live preview of a LuaLaTeX project: whether it runs, and the
 * session while it does.
 *
 * It is opt-in per project (Settings › Builds), offered only to projects whose
 * engine is LuaLaTeX, and costs nothing until turned on: this hook is all that
 * loads with the app. Turning it on downloads the pinned rtex once (the host
 * verifies it), then loads the renderer's chunk and starts rtex on the
 * project's main document. Leaving the project, switching its engine or
 * turning it off stops rtex.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { useLatestRef } from "../hooks/use-latest-ref";
import { chunk } from "../lib/lazy-chunk";
import { onProjectFilesChanged } from "../project/project-files-changed";
import { clearLivePreviewEnabled, loadLivePreviewEnabled, persistLivePreviewEnabled } from "../settings/app-settings";
import type { LivePreviewSession } from "./live-preview-session";

/** The renderer and its session: loaded only once live preview is on. */
export const loadLivePreviewModule = chunk(() => import("./live-preview-chunk"));

export type LivePreviewInstall = { supported: boolean; installed: boolean; version: string };
type InstallProgress = { stage: "downloading" | "verifying" | "complete"; progress: number };

export type LivePreviewState =
  | { kind: "off" }
  | { kind: "downloading"; progress: number }
  | { kind: "starting" }
  | { kind: "running"; session: LivePreviewSession }
  | { kind: "failed"; message: string };

/** What the build pipeline tells the session (see LivePreviewSession). */
export type LivePreviewBuildHooks = Pick<LivePreviewSession, "noteSaved" | "buildStarted" | "baseLoading" | "baseShown" | "basePageCount">;

const OFF: LivePreviewState = { kind: "off" };

export function useLivePreview({ project, activeFile, source, savedSource }: {
  project: ProjectSnapshot | null;
  activeFile: string;
  source: string;
  savedSource: string;
}) {
  const { t } = useLingui();
  const root = project?.root ?? null;
  const available = project?.manifest.engine === "lualatex";
  const rootDocuments = project?.manifest.rootDocuments;
  const mainFile = (rootDocuments?.find((document) => document.isDefault) ?? rootDocuments?.[0])?.path ?? null;
  const [enabledFor, setEnabledFor] = useState<{ root: string | null; enabled: boolean }>({ root: null, enabled: false });
  const enabled = enabledFor.root === root ? enabledFor.enabled : Boolean(root && loadLivePreviewEnabled(root));
  if (enabledFor.root !== root) setEnabledFor({ root, enabled });
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LivePreviewState>(OFF);
  /** The running session, for the build pipeline's calls; null otherwise. */
  const buildHooks = useRef<LivePreviewBuildHooks | null>(null);
  const projectRef = useLatestRef(project);

  const active = Boolean(root && available && enabled && mainFile);
  useEffect(() => {
    if (!active || !root || !mainFile) {
      setState(OFF);
      return;
    }
    let cancelled = false;
    let session: LivePreviewSession | null = null;
    void (async () => {
      const install = await invoke<LivePreviewInstall>("live_preview_status");
      if (!install.supported) throw new Error(t`Live preview needs a Mac with Apple silicon.`);
      if (!install.installed) {
        setState({ kind: "downloading", progress: 0 });
        const onProgress = new Channel<InstallProgress>();
        onProgress.onmessage = (progress) => {
          if (!cancelled && progress.stage === "downloading") setState({ kind: "downloading", progress: progress.progress });
        };
        await invoke("live_preview_install", { onProgress });
      }
      if (cancelled) return;
      setState({ kind: "starting" });
      const { LivePreviewSession } = await loadLivePreviewModule();
      if (cancelled) return;
      session = new LivePreviewSession(root, mainFile);
      buildHooks.current = session;
      setState({ kind: "running", session });
      await session.start();
    })().catch((reason: unknown) => {
      session?.dispose();
      buildHooks.current = null;
      if (!cancelled) setState({ kind: "failed", message: toMessage(reason) });
    });
    return () => {
      cancelled = true;
      buildHooks.current = null;
      session?.dispose();
    };
  }, [active, attempt, mainFile, root, t]);

  const session = state.kind === "running" ? state.session : null;
  // The open file as it is typed, and as it is on disk.
  useEffect(() => {
    session?.noteText(activeFile, source, savedSource);
  }, [activeFile, savedSource, session, source]);
  // The rest of the project as the watcher sees it change: an Overleaf pull,
  // the agent, another editor.
  useEffect(() => {
    if (!session || !root) return;
    return onProjectFilesChanged(root, (paths) => (
      session.noteFilesChanged(paths, flattenProjectPaths(projectRef.current?.files ?? []))
    ));
  }, [projectRef, root, session]);

  const setEnabled = useCallback((next: boolean) => {
    if (!root) return;
    persistLivePreviewEnabled(root, next);
    setEnabledFor({ root, enabled: next });
  }, [root]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  /** Turn live preview off everywhere and delete rtex and its build folders. */
  const remove = useCallback(async () => {
    clearLivePreviewEnabled();
    setEnabledFor({ root, enabled: false });
    return invoke<LivePreviewInstall>("live_preview_remove");
  }, [root]);

  // One identity while nothing here changes: the PDF panel and Settings take
  // it, and typing re-renders App on every keystroke.
  return useMemo(
    () => ({ available, enabled, state, setEnabled, retry, remove, buildHooks }),
    [available, enabled, remove, retry, setEnabled, state],
  );
}

export type LivePreview = ReturnType<typeof useLivePreview>;
