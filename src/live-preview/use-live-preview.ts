/**
 * The rtex live preview of a LuaLaTeX project: whether it runs, and the
 * session while it does.
 *
 * It is offered only to projects whose engine is LuaLaTeX, and is on there
 * unless the writer turns it off (Settings › Builds; see
 * loadLivePreviewEnabled). This hook is all that loads with the app. The
 * first LuaLaTeX project opened downloads the pinned rtex in the background
 * once the window is idle (the host verifies it), then loads the renderer's
 * chunk and starts rtex on the project's main document. A Mac that cannot run
 * it downloads nothing, and a failed download leaves the normal build alone:
 * neither shows over the PDF, only in Settings; nor does a main document in a
 * subfolder, which rtex cannot typeset as the build does. Leaving the project,
 * switching its engine or turning it off stops rtex.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { whenIdle } from "../app/effect-helpers";
import { useLatestRef } from "../hooks/use-latest-ref";
import { chunk } from "../lib/lazy-chunk";
import { onProjectFilesChanged } from "../project/project-files-changed";
import { disableLivePreviewEverywhere, loadLivePreviewEnabled, persistLivePreviewEnabled } from "../settings/app-settings";
import type { LivePreviewSession } from "./live-preview-session";

/** The renderer and its session: loaded only once live preview is on. */
export const loadLivePreviewModule = chunk(() => import("./live-preview-chunk"));

export type LivePreviewInstall = { supported: boolean; lualatex: boolean; installed: boolean; version: string };
type InstallProgress = { stage: "downloading" | "verifying" | "complete"; progress: number };

export type LivePreviewState =
  | { kind: "off" }
  | { kind: "downloading"; progress: number }
  | { kind: "starting" }
  | { kind: "running"; session: LivePreviewSession }
  | { kind: "failed"; message: string }
  /** This Mac has no Apple silicon or no working LuaLaTeX: nothing downloaded. */
  | { kind: "unavailable" }
  /** rtex could not be downloaded (offline, say); builds go on as usual. */
  | { kind: "download-failed"; message: string };

/** What the build pipeline tells the session (see LivePreviewSession). */
export type LivePreviewBuildHooks = Pick<
  LivePreviewSession, "noteSaved" | "buildStarted" | "buildFinished" | "baseLoading" | "baseShown" | "basePageCount" | "getSnapshot"
>;

const OFF: LivePreviewState = { kind: "off" };
const STARTING: LivePreviewState = { kind: "starting" };

export function useLivePreview({ project, activeFile, source, savedSource }: {
  project: ProjectSnapshot | null;
  activeFile: string;
  source: string;
  savedSource: string;
}) {
  const root = project?.root ?? null;
  const available = project?.manifest.engine === "lualatex";
  const rootDocuments = project?.manifest.rootDocuments;
  const rootDocument = (rootDocuments?.find((document) => document.isDefault) ?? rootDocuments?.[0])?.path ?? null;
  // rtex typesets from the project folder, latexmk from the document's own
  // (-cd): a document in a subfolder would come out with its bibliography and
  // other relative paths missing, drawn over the build's pages. Its PDF is
  // the build's alone, and Settings says why.
  const subfolderDocument = rootDocument?.includes("/") ? rootDocument : null;
  const mainFile = subfolderDocument ? null : rootDocument;
  const [enabledFor, setEnabledFor] = useState<{ root: string | null; enabled: boolean }>({ root: null, enabled: false });
  const enabled = enabledFor.root === root ? enabledFor.enabled : Boolean(root && loadLivePreviewEnabled(root));
  if (enabledFor.root !== root) setEnabledFor({ root, enabled });
  const [attempt, setAttempt] = useState(0);
  /** Each run's state under the key of the run it belongs to: another run's is not shown. */
  const [run, setRun] = useState<{ key: string; state: LivePreviewState }>({ key: "", state: OFF });
  /** The running session, for the build pipeline's calls; null otherwise. */
  const buildHooks = useRef<LivePreviewBuildHooks | null>(null);
  const projectRef = useLatestRef(project);

  const active = Boolean(root && available && enabled && mainFile);
  const runKey = active ? `${root}\n${mainFile}\n${attempt}` : "";
  const state = useMemo<LivePreviewState>(
    () => (!active ? OFF : run.key === runKey ? run.state : STARTING),
    [active, run, runKey],
  );
  useEffect(() => {
    if (!runKey || !root || !mainFile) return;
    const setState = (next: LivePreviewState) => setRun({ key: runKey, state: next });
    let cancelled = false;
    let cancelIdle = () => {};
    let session: LivePreviewSession | null = null;
    void (async () => {
      const install = await invoke<LivePreviewInstall>("live_preview_status");
      if (cancelled) return;
      if (!install.supported || !install.lualatex) {
        setState({ kind: "unavailable" });
        return;
      }
      if (!install.installed) {
        // Not while the project is still opening: its first build, the file
        // tree and the agent come first.
        await new Promise<void>((resolve) => { cancelIdle = whenIdle(resolve, 5_000, 2_000); });
        if (cancelled) return;
        setState({ kind: "downloading", progress: 0 });
        const onProgress = new Channel<InstallProgress>();
        onProgress.onmessage = (progress) => {
          if (!cancelled && progress.stage === "downloading") setState({ kind: "downloading", progress: progress.progress });
        };
        try {
          await invoke("live_preview_install", { onProgress });
        } catch (reason) {
          if (!cancelled) setState({ kind: "download-failed", message: toMessage(reason) });
          return;
        }
      }
      if (cancelled) return;
      setState({ kind: "starting" });
      const { LivePreviewSession } = await loadLivePreviewModule();
      if (cancelled) return;
      session = new LivePreviewSession(root, mainFile);
      buildHooks.current = session;
      // The perf lab's harness reads the session (src/platform/perf-lab-harness.ts).
      if (import.meta.env.VITE_PERF_LAB) Object.assign(window, { __latticeLiveSession: session });
      setState({ kind: "running", session });
      await session.start(flattenProjectPaths(projectRef.current?.files ?? []));
    })().catch((reason: unknown) => {
      session?.dispose();
      buildHooks.current = null;
      if (!cancelled) setState({ kind: "failed", message: toMessage(reason) });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      buildHooks.current = null;
      session?.dispose();
    };
  }, [mainFile, projectRef, root, runKey]);

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
    disableLivePreviewEverywhere();
    setEnabledFor({ root, enabled: false });
    return invoke<LivePreviewInstall>("live_preview_remove");
  }, [root]);

  // One identity while nothing here changes: the PDF panel and Settings take
  // it, and typing re-renders App on every keystroke.
  return useMemo(
    () => ({ available, enabled, subfolderDocument, state, setEnabled, retry, remove, buildHooks }),
    [available, enabled, remove, retry, setEnabled, state, subfolderDocument],
  );
}

export type LivePreview = ReturnType<typeof useLivePreview>;
