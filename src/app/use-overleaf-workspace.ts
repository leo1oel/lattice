import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  loadOverleafRemoteDelete,
  loadOverleafSyncMode,
  type OverleafRemoteDelete,
  type OverleafSyncMode,
} from "../settings/app-settings";
import { logAction } from "../telemetry/app-notify";
import { setError, setNotice, setWarning } from "./notify";
import {
  confirmAction,
  isWholeFileEditorPath,
  overleafLinkMatchesSession,
  toMessage,
} from "../app-utils";
import { useOverleafRealtime } from "../overleaf/use-overleaf-realtime";
import { useOverleafChat } from "../overleaf/use-overleaf-chat";
import { useOverleafPresence, type PresenceUser } from "../overleaf/use-overleaf-presence";
import { useOverleafComments, type OverleafComments } from "../overleaf/use-overleaf-comments";
import { useOverleafTrackChanges } from "../overleaf/use-overleaf-track-changes";
import { type PresenceCursor } from "../overleaf/overleaf-cursors";
import type { OverleafCollabTab } from "../overleaf/overleaf-collab";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { EditorCollabSession } from "../collab/collab-session";
import type {
  AssetPreview,
  BuildResult,
  EditorPosition,
  FileViewState,
  OverleafLink,
  OverleafProbe,
  OverleafStatus,
  OverleafSyncResult,
  PaperSummary,
  ProjectSnapshot,
} from "../app-types";

/**
 * Marks a comment that lives on Overleaf rather than in this project. Module
 * scope so the comment handlers that still live in App can recognise the
 * prefix without the workspace hook having to hand it back.
 */
export const OVERLEAF_COMMENT_PREFIX = "overleaf:";

type OverleafSyncOptions = {
  auto?: boolean;
  observedRemoteVersion?: number | null;
  /** Whole-file editors normally stay protected; these paths are ready to flush. */
  includeWholeFilePaths?: readonly string[];
};

function isTransientOverleafTransportFailure(reason: unknown): boolean {
  const message = toMessage(reason).toLowerCase();
  return message.includes("could not reach overleaf")
    || message.includes("error decoding response body");
}

/**
 * Everything the Overleaf bridge borrows from App. Deliberately explicit: the
 * bridge sits in the middle of App's save/build/collaboration wiring, and an
 * `any`-shaped bag would hide which of those it is actually allowed to touch.
 *
 * The three sync-gate refs are owned by App rather than created here because
 * `beginProjectTransition` and `startProjectTransition` — both declared long
 * before this hook runs — have to be able to wait a sync out.
 */
export type OverleafWorkspaceDeps = {
  project: ProjectSnapshot | null;
  /** Imperative project identity; async work compares against it before committing. */
  projectRef: RefObject<ProjectSnapshot | null>;
  projectOperationGenerationRef: RefObject<number>;
  activeFile: string;
  activeFileRef: RefObject<string>;
  activePaper: PaperSummary | null;
  activeAsset: AssetPreview | null;
  source: string;
  sourceRef: RefObject<string>;
  savedSourceRef: RefObject<string>;
  setSource: (value: string) => void;
  setSavedSource: (value: string) => void;
  setViewRestore: (
    request: { path: string; cursor: number; scrollTop: number; id: string },
  ) => void;
  viewStateRef: RefObject<Map<string, FileViewState>>;
  editorPosition: EditorPosition | null;
  editorPositionRef: RefObject<EditorPosition | null>;
  build: BuildResult | null;
  /** Bumped whenever a save actually writes, so pushes follow real edits. */
  saveGeneration: number;
  /** Paths written since the hook last observed saveGeneration. */
  savedPathsRef: RefObject<Set<string>>;
  /** Whole-file documents currently mounted as editable surfaces. */
  wholeFileEditingPaths: readonly string[];
  /** Mounted whole-file documents that have an uncommitted control edit. */
  wholeFileDraftPaths: readonly string[];
  collabSession: EditorCollabSession | null;
  collabName: string;
  /** Runs prepare → canonical Catalog/Yjs apply → exact-byte commit for an active Share. */
  runSharedOverleafSync: (
    observedRemoteVersion?: number | null,
    livePaths?: readonly string[],
  ) => Promise<OverleafSyncResult>;
  save: () => Promise<boolean>;
  compile: () => Promise<void>;
  loadFile: (
    path: string,
    options?: { expectedProjectRoot?: string; projectGeneration?: number },
  ) => Promise<boolean>;
  refreshProject: (scope?: {
    expectedRoot: string;
    generation: number;
  }) => Promise<ProjectSnapshot>;
  openProjectFile: (path: string, line?: number) => Promise<void>;
  /** True while a sync owns the project; a switch has to wait it out. */
  overleafSyncingRef: RefObject<boolean>;
  /** Resolves when the in-flight Overleaf sync has finished its disk refresh. */
  overleafSyncSettledRef: RefObject<Promise<void> | null>;
  resolveOverleafSyncRef: RefObject<(() => void) | null>;
};

/**
 * The Overleaf bridge: link discovery, syncing (manual, automatic and live),
 * the realtime channel and everything that rides it — presence, chat, comment
 * threads and tracked changes.
 */
export function useOverleafWorkspace(deps: OverleafWorkspaceDeps) {
  const {
    project,
    projectRef,
    projectOperationGenerationRef,
    activeFile,
    activeFileRef,
    activePaper,
    activeAsset,
    source,
    sourceRef,
    savedSourceRef,
    setSource,
    setSavedSource,
    setViewRestore,
    viewStateRef,
    editorPosition,
    editorPositionRef,
    build,
    saveGeneration,
    savedPathsRef,
    wholeFileEditingPaths,
    wholeFileDraftPaths,
    collabSession,
    collabName,
    runSharedOverleafSync,
    save,
    compile,
    loadFile,
    refreshProject,
    openProjectFile,
    overleafSyncingRef,
    overleafSyncSettledRef,
    resolveOverleafSyncRef,
  } = deps;
  const { t } = useLingui();

  const [overleafPickerOpen, setOverleafPickerOpen] = useState(false);
  // The link is stored with the root it was fetched for, and only counts while
  // that root is still the open project. During a project switch there is one
  // render where `project` already holds the new root but this state still
  // holds the previous project's link; trusting the raw state in that window
  // sent auto-sync at the new, unlinked project ("Sync failed: This project is
  // not linked to an Overleaf project."). Keep inactive links too, so a paused
  // link or a folder whose account is disconnected is not offered for upload
  // as a second Overleaf project.
  const [overleafLinkFor, setOverleafLinkFor] = useState<{
    root: string;
    link: OverleafLink;
    active: boolean;
  } | null>(null);
  const overleafLinkLoadGenerationRef = useRef(0);
  const currentOverleafLink = overleafLinkFor?.root === project?.root ? overleafLinkFor : null;
  const overleafLink = currentOverleafLink?.active
    ? currentOverleafLink.link
    : null;
  const overleafProjectLinked = currentOverleafLink !== null;
  const [overleafSyncing, setOverleafSyncing] = useState(false);
  const [overleafSyncMode, setOverleafSyncMode] = useState<OverleafSyncMode>(loadOverleafSyncMode);
  const [overleafRemoteDelete, setOverleafRemoteDelete] = useState<OverleafRemoteDelete>(
    loadOverleafRemoteDelete,
  );
  const [overleafRemoteChanges, setOverleafRemoteChanges] = useState(false);
  const [overleafReviewOpen, setOverleafReviewOpen] = useState(false);
  const [overleafCollabOpen, setOverleafCollabOpen] = useState(false);
  const [overleafCollabTab, setOverleafCollabTab] = useState<OverleafCollabTab>("comments");
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const overleafStartupCheckedRoot = useRef<string | null>(null);
  const overleafSyncRef = useRef<(options?: OverleafSyncOptions) => Promise<void>>(async () => {});
  const overleafTransportRetryRef = useRef(false);
  const overleafCommentsRef = useRef<OverleafComments>(null as unknown as OverleafComments);
  /** Files the realtime channel owns; syncing must not touch them. */
  const overleafLivePathsRef = useRef<string[]>([]);
  const wholeFileEditingPathsRef = useRef<readonly string[]>(wholeFileEditingPaths);
  const wholeFileDraftPathsRef = useRef<readonly string[]>(wholeFileDraftPaths);
  const deferredWholeFilePathsRef = useRef(new Set<string>());
  const wholeFileIdleTimerRef = useRef<number | null>(null);
  const wholeFileBoundaryTimerRef = useRef<number | null>(null);
  const wholeFileBoundaryPathsRef = useRef(new Set<string>());
  const flushDeferredWholeFileSyncRef = useRef<(
    paths?: readonly string[],
  ) => Promise<void>>(async () => {});
  /** Whether the realtime channel is up, for the poll loop to read. */
  const overleafChannelLiveRef = useRef(false);
  /** Path → Overleaf's id and kind, which is what its endpoints take. */
  const overleafEntitiesRef = useRef<Map<string, { id: string; kind: string }>>(new Map());
  const overleafRemoteDeleteRef = useRef<OverleafRemoteDelete>("ask");
  /** How often live mode asks Overleaf whether anything changed. */
  const OVERLEAF_LIVE_POLL_MS = 3_000;
  /** Quiet time after a save before local work is pushed up. */
  const OVERLEAF_PUSH_DEBOUNCE_MS = 2_500;
  /** Let editor cleanup writes settle before syncing a file that just became inactive. */
  const OVERLEAF_WHOLE_FILE_SETTLE_MS = 1_000;
  /** A long quiet edit still gets a durable remote checkpoint. */
  const OVERLEAF_WHOLE_FILE_IDLE_MS = 60_000;
  /** Cadence when Overleaf gives us no cheap way to detect a change. */
  const OVERLEAF_BLIND_POLL_MS = 120_000;
  /**
   * Cadence once the realtime channel is up. Documents arrive as operations
   * then, so polling only has figures and newly added files left to catch —
   * and every "yes" costs a full project download, which is what earned a 429.
   */
  const OVERLEAF_CHANNEL_POLL_MS = 45_000;
  /**
   * Floor between full syncs. Overleaf allows ten project downloads a minute
   * and answers 429 past that; a collaborator typing steadily moves the
   * project version on every poll, so without a floor live mode would ask for
   * the whole project every three seconds and get itself locked out.
   */
  const OVERLEAF_MIN_SYNC_GAP_MS = 12_000;
  /**
   * The same floor once the channel is up. Documents already travel as
   * operations then, so this sweep is only carrying figures and files added
   * outside the editor, and it can afford to be leisurely.
   */
  const OVERLEAF_CHANNEL_SYNC_GAP_MS = 30_000;
  const lastAutoSyncRef = useRef(0);
  const lastAutoVersionRef = useRef(0);

  useLayoutEffect(() => {
    wholeFileEditingPathsRef.current = wholeFileEditingPaths;
    wholeFileDraftPathsRef.current = wholeFileDraftPaths;
  }, [wholeFileDraftPaths, wholeFileEditingPaths]);

  const currentOverleafLivePaths = useCallback((includeWholeFilePaths: readonly string[] = []) => {
    const included = new Set(includeWholeFilePaths);
    const drafts = new Set(wholeFileDraftPathsRef.current);
    return Array.from(new Set([
      ...overleafLivePathsRef.current,
      ...wholeFileEditingPathsRef.current.filter((path) => !included.has(path) || drafts.has(path)),
    ]));
  }, []);

  const captureSavedPaths = useCallback(() => {
    const paths = Array.from(savedPathsRef.current);
    savedPathsRef.current.clear();
    for (const path of paths) {
      if (isWholeFileEditorPath(path)) deferredWholeFilePathsRef.current.add(path);
    }
    return paths;
  }, [savedPathsRef]);

  useEffect(() => {
    overleafTransportRetryRef.current = false;
  }, [project?.root]);

  // ---- Overleaf bridge -----------------------------------------------------

  // Know whether the open project is linked to an Overleaf project (cloned via
  // "Open from Overleaf"). Drives the toolbar sync button and auto-sync.
  useEffect(() => {
    let cancelled = false;
    const generation = ++overleafLinkLoadGenerationRef.current;
    setOverleafLinkFor(null);
    if (!project?.root) return;
    const root = project.root;
    void Promise.all([
      invoke<OverleafStatus>("overleaf_status"),
      invoke<OverleafLink | null>("overleaf_link"),
    ])
      .then(([status, link]) => {
        if (!cancelled && generation === overleafLinkLoadGenerationRef.current) {
          setOverleafLinkFor(link ? {
            root,
            link: { ...link, host: link.host.trim() || status.host.trim() },
            active: status.connected
              && !link.paused
              && overleafLinkMatchesSession(status.host, link.host),
          } : null);
        }
      })
      .catch(() => {
        // A project without the state file is simply not linked.
      });
    return () => {
      cancelled = true;
    };
  }, [project?.root]);

  /**
   * Re-read the link after Settings changes it. Unlinking has to be felt
   * everywhere — the toolbar cloud, the live channel, chat, collaborators and
   * the comment threads all key off this, and they used to keep running
   * against a project that had just been unlinked.
   */
  const refreshOverleafLink = useCallback(() => {
    const root = projectRef.current?.root;
    if (!root) return;
    const generation = ++overleafLinkLoadGenerationRef.current;
    void Promise.all([
      invoke<OverleafStatus>("overleaf_status"),
      invoke<OverleafLink | null>("overleaf_link"),
    ])
      .then(([status, link]) => {
        if (
          projectRef.current?.root !== root
          || generation !== overleafLinkLoadGenerationRef.current
        ) return;
        setOverleafLinkFor(link ? {
          root,
          link: { ...link, host: link.host.trim() || status.host.trim() },
          active: status.connected
            && !link.paused
            && overleafLinkMatchesSession(status.host, link.host),
        } : null);
      })
      .catch(() => {
        if (generation === overleafLinkLoadGenerationRef.current) {
          setOverleafLinkFor(null);
        }
      });
    // The refs arrive through `deps`, so the lint rule cannot see that they are
    // `useRef` results with a stable identity; listing them changes nothing.
  }, [projectRef]);

  const publishProjectToOverleaf = useCallback(async (projectName: string): Promise<boolean> => {
    if (!project || overleafSyncingRef.current) return false;
    const publishRoot = project.root;
    const publishGeneration = projectOperationGenerationRef.current;
    const stillCurrent = () => (
      projectOperationGenerationRef.current === publishGeneration
      && projectRef.current?.root === publishRoot
    );
    overleafSyncingRef.current = true;
    setOverleafSyncing(true);
    // Publishing mutates Overleaf and writes the local sync baseline. Give a
    // project switch the same settlement gate as ordinary sync so the request
    // cannot finish against a workspace the window has already left.
    overleafSyncSettledRef.current = new Promise<void>((resolve) => {
      resolveOverleafSyncRef.current = resolve;
    });
    const publish = save().then(async (saved) => {
      if (!saved || !stillCurrent()) return false;
      const link = await invoke<OverleafLink>("overleaf_publish_project", {
        projectRoot: publishRoot,
        projectName,
      });
      if (!stillCurrent()) return false;
      setOverleafLinkFor({ root: publishRoot, link, active: true });
      return true;
    });
    return publish.finally(() => {
      overleafSyncingRef.current = false;
      setOverleafSyncing(false);
      const settle = resolveOverleafSyncRef.current;
      resolveOverleafSyncRef.current = null;
      overleafSyncSettledRef.current = null;
      settle?.();
    });
  }, [
    overleafSyncSettledRef,
    overleafSyncingRef,
    project,
    projectOperationGenerationRef,
    projectRef,
    resolveOverleafSyncRef,
    save,
  ]);

  const openCurrentOverleafProject = useCallback(() => {
    if (!overleafLink) return;
    try {
      const url = new URL(overleafLink.host);
      url.pathname = `/project/${encodeURIComponent(overleafLink.projectId)}`;
      url.search = "";
      url.hash = "";
      void openUrl(url.toString()).catch((reason) => {
        setError(`Could not open the project on Overleaf: ${toMessage(reason)}`);
      });
    } catch {
      setError("Could not open the project because its Overleaf host is invalid.");
    }
  }, [overleafLink]);

  /**
   * Deal with files that are gone here but still on Overleaf.
   *
   * Deleting an ordinary file from a shared project is not something to infer
   * from its absence, so this obeys the setting: leave it, remove it, or ask.
   * App-owned transient paths bypass that policy and are cleaned silently.
   * Removing either kind needs the entity's Overleaf id, which only the
   * realtime channel knows — without it there is nothing to name in the
   * request, so the action waits for a later sync.
   */
  const settleRemoteDeletes = useCallback(async (
    paths: string[],
    projectRoot: string,
    generation: number,
    automatic = false,
  ) => {
    const stillCurrent = () => (
      projectOperationGenerationRef.current === generation
      && projectRef.current?.root === projectRoot
    );
    if (!stillCurrent()) return;
    const policy = overleafRemoteDeleteRef.current;
    if (!automatic && policy === "never") return;
    const known = paths
      .map((path) => ({ path, entity: overleafEntitiesRef.current.get(path) }))
      .filter((entry): entry is { path: string; entity: { id: string; kind: string } } => (
        entry.entity !== undefined
      ));
    if (!known.length) return;
    if (!automatic && policy === "ask") {
      const names = known.map((entry) => entry.path).join(", ");
      const removeThem = await confirmAction({
        title: known.length === 1
          ? t`Remove one file from the Overleaf project?`
          : t({ message: `Remove ${known.length} files from the Overleaf project?` }),
        message: known.length === 1
          ? t({ message: `${names} was deleted from the local project, but is still on Overleaf. Even if you remove it now, Overleaf's history will keep it.` })
          : t({ message: `${names} were deleted from the local project, but are still on Overleaf. Even if you remove them now, Overleaf's history will keep them.` }),
        confirmLabel: t`Delete on Overleaf too`,
        destructive: true,
      });
      if (!removeThem || !stillCurrent()) return;
    }
    for (const entry of known) {
      if (!stillCurrent()) return;
      try {
        await invoke("overleaf_delete_entity", {
          projectRoot,
          kind: entry.entity.kind,
          entityId: entry.entity.id,
        });
      } catch (reason) {
        if (stillCurrent()) {
          setError(t({ message: `Could not remove ${entry.path} from Overleaf: ${toMessage(reason)}` }), "Overleaf");
        }
        return;
      }
    }
    if (stillCurrent() && !automatic) {
      setNotice(known.length === 1
        ? t`Removed one file from Overleaf`
        : t({ message: `Removed ${known.length} files from Overleaf` }), "Overleaf");
    }
  }, [projectOperationGenerationRef, projectRef, t]);

  const runOverleafSync = useCallback(async (options?: OverleafSyncOptions) => {
    if (!project || overleafSyncingRef.current) return;
    const syncRoot = project.root;
    const syncGeneration = projectOperationGenerationRef.current;
    const stillCurrent = () => (
      projectOperationGenerationRef.current === syncGeneration
      && projectRef.current?.root === syncRoot
    );
    overleafSyncingRef.current = true;
    setOverleafSyncing(true);
    // Handle a project switch can wait on, so a click that lands mid-sync
    // queues behind it instead of being thrown away.
    overleafSyncSettledRef.current = new Promise<void>((resolve) => { resolveOverleafSyncRef.current = resolve; });
    const trace = logAction("Overleaf", "Sync", options?.auto ? "automatic" : "requested");
    // Saving below clears the dirty flag, which cancels the pending autosave
    // compile — that is how a sync landing mid-edit left the editor showing a
    // change the PDF never caught up with. Remember it so we can rebuild.
    const hadUnsavedEdits = sourceRef.current !== savedSourceRef.current;
    let compiled = false;
    try {
      if (!(await save())) return;
      if (!stillCurrent()) return;
      const livePaths = currentOverleafLivePaths(
        options?.auto
          ? options.includeWholeFilePaths
          : wholeFileEditingPathsRef.current,
      );
      const sharedSync = collabSession !== null;
      const result = sharedSync
        ? await runSharedOverleafSync(options?.observedRemoteVersion, livePaths)
        : await invoke<OverleafSyncResult>("overleaf_sync", {
            projectRoot: syncRoot,
            live: livePaths,
            observedRemoteVersion: options?.observedRemoteVersion ?? null,
          });
      if (!stillCurrent()) return;
      overleafTransportRetryRef.current = false;
      // Every pending whole-file path omitted from `livePaths` participated in
      // this successful sync. Forget it now so a later blur does not perform a
      // duplicate project download for work that is already remote.
      const protectedPaths = new Set(livePaths);
      for (const path of deferredWholeFilePathsRef.current) {
        if (!protectedPaths.has(path)) deferredWholeFilePathsRef.current.delete(path);
      }
      // PDF inspection generates contact sheets and page renders under this
      // app-owned folder. Old versions uploaded them as project files; remove
      // that legacy folder silently and never mix it into the user's ordinary
      // remote-delete preference.
      if (result.automaticRemoteDeletes?.length && !result.readOnly) {
        await settleRemoteDeletes(
          result.automaticRemoteDeletes,
          syncRoot,
          syncGeneration,
          true,
        );
        if (!stillCurrent()) return;
      }
      // A file gone from here is still on Overleaf, because syncing has never
      // removed anything from a shared project on its own. What should happen
      // instead is a decision only the user can make, so it is a setting.
      if (result.skippedRemoteDeletes.length) {
        await settleRemoteDeletes(
          result.skippedRemoteDeletes,
          syncRoot,
          syncGeneration,
        );
        if (!stillCurrent()) return;
      }
      // A file too big for Overleaf to accept stays here and is named, because
      // to the writer it otherwise looks synced like everything else and the
      // absence is only discovered from the other side.
      if (result.skippedLarge?.length) {
        setWarning(
          `Too large for Overleaf, so left on this machine: ${result.skippedLarge.join(", ")}.`,
          "Overleaf",
        );
      }
      // Merged and conflicted files were rewritten on disk just like pulled
      // ones, so the editor has to reload them too or it would keep showing
      // stale text and save over the incoming edits.
      const changedOnDisk = new Set([
        ...result.pulled,
        ...result.merged,
        ...result.conflicts.map((item) => item.path),
      ]);
      if (result.conflicts.length) {
        // A file with markers in it has spots to work through; a figure or a
        // PDF does not, and saying "resolve each spot" about one — then
        // opening a marker resolver that finds nothing — is worse than saying
        // plainly that both versions are sitting on disk.
        const marked = result.conflicts.filter((item) => item.markers !== false);
        const whole = result.conflicts.filter((item) => item.markers === false);
        const parts: string[] = [];
        if (marked.length) {
          parts.push(
            `Overleaf sync could not combine: ${marked.map((item) => item.path).join(", ")}. `
            + "Both versions are kept — resolve each spot to finish. "
            + "Your untouched version is also saved beside it in the “(local conflict …)” files, "
            + "and nothing uploads until the conflicts are settled.",
          );
        }
        if (whole.length) {
          parts.push(
            `Changed in both places and impossible to combine: ${whole.map((item) => item.path).join(", ")}. `
            + "Overleaf's version is now the one in the project, and yours is kept beside it "
            + "in the “(local conflict …)” files — keep whichever you want and delete the other.",
          );
        }
        setError(parts.join(" "));
        // Only worth opening for a file that actually has markers in it.
        const first = marked[0]?.path ?? null;
        if (first) setConflictPath(first);
      }
      if (changedOnDisk.size || result.deletedLocal.length) {
        await refreshProject({ expectedRoot: syncRoot, generation: syncGeneration });
        if (!stillCurrent()) return;
        // Navigation is allowed while the network-bound sync is running. Use
        // the file that is active now, not the one captured when sync began,
        // so an incoming replacement cannot leave the newly opened editor on
        // stale bytes.
        const currentActiveFile = activeFileRef.current;
        if (currentActiveFile && changedOnDisk.has(currentActiveFile)) {
          await loadFile(currentActiveFile, {
            expectedProjectRoot: syncRoot,
            projectGeneration: syncGeneration,
          });
          if (!stillCurrent()) return;
        }
        if (!stillCurrent()) return;
        await compile();
        if (!stillCurrent()) return;
        compiled = true;
      }
      // Nothing arrived, but we flushed the user's own unsaved edits — the
      // autosave compile they were waiting on is gone, so run it here.
      if (!compiled && hadUnsavedEdits) {
        if (!stillCurrent()) return;
        await compile();
        if (!stillCurrent()) return;
        compiled = true;
      }
      if (result.pulled.length || result.pushed.length || result.merged.length) {
        const parts = [`pulled ${result.pulled.length}`, `pushed ${result.pushed.length}`];
        if (result.merged.length) parts.push(`merged ${result.merged.length}`);
        trace.ok(`Overleaf: ${parts.join(", ")}.`);
      } else if (!options?.auto) {
        trace.ok("Overleaf: already up to date.");
      } else {
        // A background sync with nothing to do stays out of the user's way, but
        // still leaves a line in the log so a gap in sync history is explained.
        trace.note("Overleaf: already up to date.");
      }
      const changedProjectContent = hadUnsavedEdits
        || result.pulled.length > 0
        || result.pushed.length > 0
        || result.merged.length > 0
        || result.conflicts.length > 0
        || result.deletedLocal.length > 0;
      // Only a real content transition becomes a version. A no-op sync used
      // to run `git add -A` anyway, waking the filesystem watcher and making
      // unrelated previews reload even though Overleaf changed nothing.
      if (!stillCurrent()) return;
      if (changedProjectContent) {
        void invoke<string | null>("git_auto_commit", {
          message: "Overleaf sync",
          author: collabName.trim() || null,
          projectRoot: syncRoot,
        }).catch(() => {});
      }
      if (stillCurrent()) refreshOverleafLink();
    } catch (reason) {
      if (stillCurrent()) {
        if (options?.auto && isTransientOverleafTransportFailure(reason)) {
          // The live loop retries on its normal, rate-limited cadence. Retrying
          // immediately risks another 429, while raising a toast for a brief
          // background outage interrupts work even when the next pass recovers.
          overleafTransportRetryRef.current = true;
          trace.note(toMessage(reason));
        } else {
          trace.fail(reason);
        }
      }
    } finally {
      overleafSyncingRef.current = false;
      setOverleafSyncing(false);
      const settle = resolveOverleafSyncRef.current;
      resolveOverleafSyncRef.current = null;
      overleafSyncSettledRef.current = null;
      settle?.();
    }
    // The refs arrive through `deps`, so the lint rule cannot see that they are
    // `useRef` results with a stable identity; listing them changes nothing at
    // runtime. They are listed anyway so this callback stops carrying a standing
    // exhaustive-deps warning, making the next genuine omission easier to miss.
  }, [
    activeFileRef,
    collabName,
    collabSession,
    compile,
    currentOverleafLivePaths,
    loadFile,
    overleafSyncSettledRef,
    overleafSyncingRef,
    project,
    projectOperationGenerationRef,
    projectRef,
    refreshOverleafLink,
    refreshProject,
    resolveOverleafSyncRef,
    runSharedOverleafSync,
    save,
    savedSourceRef,
    settleRemoteDeletes,
    sourceRef,
  ]);

  // Live mode keeps a linked project close to current without anyone pressing
  // anything. Asking Overleaf "has your history moved?" is a small JSON call,
  // so it can run every few seconds; the expensive full sync only follows when
  // the answer is yes. That is what makes seconds-level latency affordable —
  // polling the project itself would mean re-downloading it every time.
  overleafSyncRef.current = runOverleafSync;

  const flushDeferredWholeFileSync = useCallback(async (paths?: readonly string[]) => {
    if (!overleafLink || overleafSyncMode !== "live" || !project?.root) return;
    captureSavedPaths();
    const requested = paths ?? Array.from(deferredWholeFilePathsRef.current);
    const drafts = new Set(wholeFileDraftPathsRef.current);
    const ready = requested.filter((path) => (
      deferredWholeFilePathsRef.current.has(path) && !drafts.has(path)
    ));
    if (!ready.length) {
      if (requested.some((path) => deferredWholeFilePathsRef.current.has(path))) {
        if (wholeFileIdleTimerRef.current !== null) {
          window.clearTimeout(wholeFileIdleTimerRef.current);
        }
        wholeFileIdleTimerRef.current = window.setTimeout(() => {
          wholeFileIdleTimerRef.current = null;
          void flushDeferredWholeFileSyncRef.current(requested);
        }, OVERLEAF_WHOLE_FILE_SETTLE_MS);
      }
      return;
    }
    const syncRoot = project.root;
    if (overleafSyncingRef.current) {
      await overleafSyncSettledRef.current;
    }
    if (projectRef.current?.root !== syncRoot) return;
    const pathsToSync = ready.filter((path) => deferredWholeFilePathsRef.current.has(path));
    if (!pathsToSync.length) return;
    lastAutoSyncRef.current = Date.now();
    await overleafSyncRef.current({
      auto: true,
      includeWholeFilePaths: pathsToSync,
    });
  }, [
    OVERLEAF_WHOLE_FILE_SETTLE_MS,
    captureSavedPaths,
    overleafLink,
    overleafSyncMode,
    overleafSyncSettledRef,
    overleafSyncingRef,
    project?.root,
    projectRef,
  ]);
  useLayoutEffect(() => {
    flushDeferredWholeFileSyncRef.current = flushDeferredWholeFileSync;
  }, [flushDeferredWholeFileSync]);

  const previousWholeFileEditingPathsRef = useRef<readonly string[]>(wholeFileEditingPaths);
  useEffect(() => {
    const editing = new Set(wholeFileEditingPaths);
    const left = previousWholeFileEditingPathsRef.current.filter((path) => !editing.has(path));
    previousWholeFileEditingPathsRef.current = wholeFileEditingPaths;
    // A document switch can batch with the editor's final persistence update.
    // Capture that path here too, rather than relying on the save-generation
    // effect having run in an earlier commit.
    for (const path of left) {
      if (!savedPathsRef.current.has(path)) continue;
      savedPathsRef.current.delete(path);
      deferredWholeFilePathsRef.current.add(path);
    }
    const pending = left.filter((path) => deferredWholeFilePathsRef.current.has(path));
    if (!pending.length) return;
    for (const path of pending) wholeFileBoundaryPathsRef.current.add(path);
    if (wholeFileBoundaryTimerRef.current !== null) {
      window.clearTimeout(wholeFileBoundaryTimerRef.current);
    }
    wholeFileBoundaryTimerRef.current = window.setTimeout(() => {
      wholeFileBoundaryTimerRef.current = null;
      const pathsToFlush = Array.from(wholeFileBoundaryPathsRef.current);
      wholeFileBoundaryPathsRef.current.clear();
      void flushDeferredWholeFileSyncRef.current(pathsToFlush);
    }, OVERLEAF_WHOLE_FILE_SETTLE_MS);
  }, [OVERLEAF_WHOLE_FILE_SETTLE_MS, savedPathsRef, wholeFileEditingPaths]);

  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live") return;
    const onBlur = () => {
      if (wholeFileBoundaryTimerRef.current !== null) {
        window.clearTimeout(wholeFileBoundaryTimerRef.current);
      }
      wholeFileBoundaryTimerRef.current = window.setTimeout(() => {
        wholeFileBoundaryTimerRef.current = null;
        void flushDeferredWholeFileSyncRef.current();
      }, OVERLEAF_WHOLE_FILE_SETTLE_MS);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [OVERLEAF_WHOLE_FILE_SETTLE_MS, overleafLink, overleafSyncMode]);

  useEffect(() => {
    const clearWholeFileSyncState = () => {
      deferredWholeFilePathsRef.current.clear();
      wholeFileBoundaryPathsRef.current.clear();
      savedPathsRef.current.clear();
      if (wholeFileIdleTimerRef.current !== null) {
        window.clearTimeout(wholeFileIdleTimerRef.current);
        wholeFileIdleTimerRef.current = null;
      }
      if (wholeFileBoundaryTimerRef.current !== null) {
        window.clearTimeout(wholeFileBoundaryTimerRef.current);
        wholeFileBoundaryTimerRef.current = null;
      }
    };
    clearWholeFileSyncState();
    return clearWholeFileSyncState;
  }, [project?.root, savedPathsRef]);

  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || !project?.root) return;
    const projectRoot = project.root;
    let stopped = false;
    let timer: number | null = null;
    let running = false;
    // Backs off when Overleaf pushes back, and stays slow when this instance
    // cannot tell us a version — polling only earns its keep when a cheap
    // check can rule a download out.
    const baseWait = () =>
      overleafChannelLiveRef.current ? OVERLEAF_CHANNEL_POLL_MS : OVERLEAF_LIVE_POLL_MS;
    let wait = baseWait();
    const scheduleNext = () => {
      if (stopped) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void tick();
      }, wait);
    };
    const tick = async () => {
      if (stopped || running) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      running = true;
      try {
        if (!overleafSyncingRef.current) {
          const probe = await invoke<OverleafProbe>("overleaf_probe", { projectRoot });
          wait = probe.versionKnown ? baseWait() : OVERLEAF_BLIND_POLL_MS;
          const minimumSyncGap = overleafChannelLiveRef.current
            ? OVERLEAF_CHANNEL_SYNC_GAP_MS
            : OVERLEAF_MIN_SYNC_GAP_MS;
          if (
            !stopped
            && overleafTransportRetryRef.current
            && Date.now() - lastAutoSyncRef.current >= minimumSyncGap
          ) {
            lastAutoSyncRef.current = Date.now();
            await overleafSyncRef.current({ auto: true });
          } else if (!stopped && !probe.versionKnown) {
            // No change signal: fall back to syncing on a slow clock rather
            // than downloading the project over and over.
            if (Date.now() - lastAutoSyncRef.current >= OVERLEAF_BLIND_POLL_MS) {
              lastAutoSyncRef.current = Date.now();
              await overleafSyncRef.current({ auto: true });
            }
          } else if (
            !stopped
            && probe.changed
            && Date.now() - lastAutoSyncRef.current >= minimumSyncGap
          ) {
            lastAutoSyncRef.current = Date.now();
            await overleafSyncRef.current({
              auto: true,
              observedRemoteVersion: probe.remoteVersion,
            });
          }
        }
      } catch (reason) {
        // Rate limiting means we are asking too often; ease off sharply rather
        // than hammering a server that has already said no.
        const message = String(reason);
        wait = /429|Too Many Requests/i.test(message)
          ? Math.min(wait * 4, 5 * 60_000)
          : Math.min(Math.max(wait * 2, baseWait()), 60_000);
      } finally {
        running = false;
        scheduleNext();
      }
    };
    void tick();
    // Coming back from the browser is the moment stale content is most
    // obvious, so check immediately rather than waiting for the next tick.
    const onFocus = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void tick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [overleafLink, overleafSyncMode, overleafSyncingRef, project?.root]);

  // Editing through Overleaf's own channel, when the project is linked and
  // live. It stays off during a Lattice share: two live channels writing the
  // same buffer would fight over every keystroke, and the Yjs session already
  // owns the editor then.
  const overleafRealtime = useOverleafRealtime({
    enabled: overleafLink !== null,
    documents: overleafSyncMode === "live" && !collabSession,
    projectRoot: project?.root ?? null,
    // Slides, boards and spreadsheets serialize their whole document at once;
    // feeding those bytes through Overleaf's character OT while their own
    // editor is active creates competing writers for the same file.
    activeFile: isWholeFileEditorPath(activeFile) ? null : activeFile,
    readCaret: () => viewStateRef.current.get(activeFileRef.current ?? "")?.text?.cursor ?? 0,
    onRemoteText: (text, caret) => {
      const path = activeFileRef.current;
      if (!path) return;
      setSource(text);
      // Write it through so a rebuild and any later sync see the same bytes,
      // and only call it saved once it is. Marking it saved first and dropping
      // the failure meant a write that could not happen — a full disk, a
      // read-only volume — left the editor showing their paragraph while the
      // file still held the old one: the build compiled the old text, and the
      // next sync read the old bytes back off disk, called them a local edit,
      // and pushed them over the top of what they had written.
      void invoke("write_project_file", {
        path,
        content: text,
        projectRoot: project?.root ?? null,
      })
        .then(() => setSavedSource(text))
        .catch((reason) => setError(toMessage(reason)));
      setViewRestore({ path, cursor: caret, scrollTop: 0, id: crypto.randomUUID() });
    },
    onNotice: (message) => setNotice(message),
  });
  // The poll loop and the sync both read these mid-flight, so keep them in
  // refs rather than restarting either one every time the channel changes.
  // "Carrying documents", not merely "connected": the channel also stays up in
  // manual mode for chat, and slowing the sync down then would leave nothing
  // watching the files.
  overleafRemoteDeleteRef.current = overleafRemoteDelete;
  overleafEntitiesRef.current = overleafRealtime.entities;
  overleafChannelLiveRef.current = overleafRealtime.status === "live"
    && overleafSyncMode === "live"
    && !collabSession;
  overleafLivePathsRef.current = overleafRealtime.livePaths;

  // On first open, check the cheap remote version and the local sync baseline
  // before downloading the whole project. Wait for joinProject first: it
  // records the root folder id that uploads require and lets the probe exclude
  // documents already owned by realtime. If this Overleaf cannot report a
  // version, or the probe itself fails, retain the safe full-sync fallback.
  useEffect(() => {
    const projectRoot = project?.root;
    if (!projectRoot) return;
    if (!overleafLink || overleafSyncMode !== "live") {
      if (overleafStartupCheckedRoot.current === projectRoot) {
        overleafStartupCheckedRoot.current = null;
      }
      return;
    }
    if (!["live", "error"].includes(overleafRealtime.status)) return;
    if (overleafStartupCheckedRoot.current === projectRoot) return;
    overleafStartupCheckedRoot.current = projectRoot;
    let cancelled = false;
    const linkGeneration = overleafLinkLoadGenerationRef.current;
    const stillCurrent = () => (
      !cancelled
      && projectRef.current?.root === projectRoot
      && overleafLinkLoadGenerationRef.current === linkGeneration
    );
    void invoke<OverleafProbe>("overleaf_probe", {
      projectRoot,
      checkLocal: true,
      live: currentOverleafLivePaths(),
    }).then((probe) => {
      if (!stillCurrent()) return;
      if (probe.versionKnown && !probe.changed && !probe.localChanged) return;
      lastAutoSyncRef.current = Date.now();
      void overleafSyncRef.current({
        auto: true,
        observedRemoteVersion: probe.remoteVersion,
      });
    }).catch(() => {
      if (!stillCurrent()) return;
      lastAutoSyncRef.current = Date.now();
      void overleafSyncRef.current({ auto: true });
    });
    return () => {
      cancelled = true;
    };
  }, [
    currentOverleafLivePaths,
    overleafLink,
    overleafRealtime.status,
    overleafSyncMode,
    project?.root,
    projectRef,
  ]);

  // Who else is in the Overleaf project, and where. Two things the presence
  // hook cannot get anywhere else ride the same channel: our own connection
  // id, announced once, and which file each document id is — the second is
  // what lets a tooltip name the file and a click jump to it.
  const [overleafSelfId, setOverleafSelfId] = useState<string | null>(null);
  const [overleafDocPaths, setOverleafDocPaths] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (overleafLink === null) {
      setOverleafSelfId(null);
      setOverleafDocPaths(new Map());
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ type: string; publicId?: string; docs?: { id: string; path: string }[] }>(
      "overleaf-realtime",
      (event) => {
        const payload = event.payload;
        if (payload.type === "connected" && payload.publicId) {
          setOverleafSelfId(payload.publicId);
        } else if ((payload.type === "projectJoined" || payload.type === "treeChanged")
          && payload.docs) {
          // Rebuilt on every tree change, not only at join: a file renamed or
          // added in the browser mid-session would otherwise keep answering
          // with the name it had when we connected, and this map is what names
          // the file behind a collaborator's caret or a comment.
          setOverleafDocPaths(new Map(payload.docs.map((doc) => [doc.id, doc.path])));
        } else if (payload.type === "disconnected") {
          setOverleafSelfId(null);
        }
      },
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [overleafLink]);

  const overleafPresence = useOverleafPresence({
    // A local project still has a root, but it has no Overleaf presence
    // scope. Passing that root here kept the previous linked project's roster
    // alive after switching projects.
    projectRoot: overleafLink ? project?.root ?? null : null,
    docId: overleafRealtime.docId,
    selfId: overleafSelfId,
    readCaret: () => {
      const position = editorPositionRef.current;
      return position?.path === activeFileRef.current
        ? { row: position.line - 1, column: position.column }
        : { row: 0, column: 0 };
    },
  });

  // Publishing a position is the only thing that makes us visible to a browser
  // that is already open, so every real caret move in the live file has to
  // reach it.
  useEffect(() => {
    if (!editorPosition || editorPosition.path !== activeFile) return;
    overleafPresence.publish(editorPosition.line - 1, editorPosition.column);
  }, [editorPosition, activeFile, overleafPresence]);

  const jumpToOverleafPeer = useCallback((peer: PresenceUser) => {
    const path = peer.docId ? overleafDocPaths.get(peer.docId) : null;
    if (!path) {
      setNotice(`${peer.name || "This collaborator"} is not in a file right now.`);
      return;
    }
    void openProjectFile(path, (peer.row ?? 0) + 1);
  }, [overleafDocPaths, openProjectFile]);

  /** Carets to draw, which is only ever the document being edited live. */
  const overleafActiveCursors = useMemo<PresenceCursor[]>(() => {
    const docId = overleafRealtime.docId;
    if (
      !docId
      || activePaper
      || activeAsset
      || overleafDocPaths.get(docId) !== activeFile
    ) return [];
    return overleafPresence.peers
      .filter((peer): peer is PresenceUser & { row: number; column: number } => (
        peer.docId === docId && peer.row !== null && peer.column !== null
      ))
      .map((peer) => ({
        name: peer.name || "Anonymous",
        hue: peer.hue,
        row: peer.row,
        column: peer.column,
      }));
  }, [activeAsset, activeFile, activePaper, overleafDocPaths, overleafPresence.peers, overleafRealtime.docId]);

  // Collaborators who stayed in the browser talk in Overleaf's chat, so it has
  // to be readable here or half the conversation happens where we cannot see
  // it. It listens on the same channel the editor uses.
  const overleafChat = useOverleafChat({
    enabled: overleafLink !== null,
    projectRoot: project?.root ?? null,
  });


  // Where each thread sits in the document being edited right now. Deliberately
  // the realtime channel's copy and not the project-wide one the comments hook
  // reads over REST: these positions become highlights in the editor, and the
  // channel moves them as the text around them is typed, while a REST snapshot
  // would keep pointing at where the words used to be until the next refresh.
  const overleafAnchors = useMemo(
    () => new Map(overleafRealtime.comments.map((range) => [range.threadId, range])),
    [overleafRealtime.comments],
  );
  const overleafComments = useOverleafComments({
    enabled: overleafLink !== null,
    projectRoot: project?.root ?? null,
    docId: overleafRealtime.docId,
    anchored: useMemo(
      () => overleafRealtime.comments.map((range) => range.threadId),
      [overleafRealtime.comments],
    ),
    anchor: overleafRealtime.anchorComment,
  });

  // Overleaf's threads, dressed as editor comments so they highlight in the
  // text and answer in place like any other. Their ids are prefixed, which is
  // how every handler below knows to send the reply to Overleaf rather than
  // writing it into this project's own comments file.
  const overleafEditorComments = useMemo<EditorComment[]>(() => {
    const path = activeFile;
    if (!path || !overleafAnchors.size) return [];
    return overleafComments.threads.flatMap((thread) => {
      const anchor = overleafAnchors.get(thread.id);
      if (!anchor) return [];
      const [first, ...rest] = thread.messages;
      return [{
        id: `${OVERLEAF_COMMENT_PREFIX}${thread.id}`,
        path,
        from: anchor.position,
        to: anchor.position + anchor.quote.length,
        quote: anchor.quote,
        prefix: "",
        suffix: "",
        body: first?.content ?? "",
        authorId: first?.authorEmail ?? "overleaf",
        authorName: first ? `${first.authorName} · Overleaf` : "Overleaf",
        resolved: thread.resolved,
        replies: rest.map((message) => ({
          id: message.id,
          authorId: message.authorEmail ?? "overleaf",
          authorName: message.authorName,
          body: message.content,
          createdAt: new Date(message.timestamp).toISOString(),
        })),
        createdAt: new Date(first?.timestamp ?? 0).toISOString(),
        updatedAt: new Date(thread.messages[thread.messages.length - 1]?.timestamp ?? 0).toISOString(),
      }];
    });
  }, [activeFile, overleafAnchors, overleafComments.threads]);

  // Suggestions: reading them is the realtime hook's job, acting on them is
  // this one's — accepting goes through an endpoint and reports no operation,
  // so the document has to be re-read afterwards.
  const overleafTrackChanges = useOverleafTrackChanges({
    enabled: overleafLink !== null,
    projectRoot: project?.root ?? null,
    docId: overleafRealtime.docId,
    reserveOperation: overleafRealtime.reserveOperation,
    noteReservedOperationUnknown: overleafRealtime.noteReservedOperationUnknown,
    settledVersion: overleafRealtime.settledVersion,
    changes: overleafRealtime.changes,
    canAct: overleafRealtime.canWrite,
    reload: overleafRealtime.reload,
  });
  // The comment handlers are declared before this hook runs, so they reach its
  // actions through a ref rather than forcing the whole tree to be reordered.
  overleafCommentsRef.current = overleafComments;

  // Keep the badge quiet while someone is reading the conversation.
  useEffect(() => {
    if (overleafCollabOpen && overleafCollabTab === "chat") overleafChat.markRead();
  }, [overleafCollabOpen, overleafCollabTab, overleafChat.messages, overleafChat.markRead]);

  // Everything typed goes to the live channel; it ignores text it already has,
  // so this is safe to call on every change including our own remote applies.
  // Depend on the two stable members, not the hook's return object — that is
  // rebuilt every render, which made this run on every render while live.
  const { liveFile: overleafLiveFile, pushLocal: overleafPushLocal } = overleafRealtime;
  useEffect(() => {
    if (!overleafLiveFile) return;
    overleafPushLocal(source);
  }, [overleafLiveFile, overleafPushLocal, source]);

  // A live channel that could not start is invisible otherwise: the dot simply
  // never appears and everything quietly keeps syncing. Say what happened once.
  const overleafRealtimeNotified = useRef<string | null>(null);
  useEffect(() => {
    if (overleafRealtime.status !== "error" || !overleafRealtime.detail) return;
    if (overleafRealtimeNotified.current === overleafRealtime.detail) return;
    overleafRealtimeNotified.current = overleafRealtime.detail;
    setNotice(
      `Live editing with Overleaf could not start (${overleafRealtime.detail}). `
      + "Your project still syncs every few seconds.",
    );
  }, [overleafRealtime.detail, overleafRealtime.status]);

  // Live mode also pushes. This keys off *saves* rather than unsaved edits:
  // autosave clears the dirty flag about a second after typing stops, well
  // before any sensible push delay, so watching for dirty text meant the push
  // was almost always cancelled before it ran.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || saveGeneration === 0) return;
    const savedPaths = captureSavedPaths();
    const wholeFilePaths = savedPaths.filter(isWholeFileEditorPath);
    if (wholeFilePaths.length) {
      const editing = new Set(wholeFileEditingPathsRef.current);
      for (const path of wholeFilePaths) {
        if (!editing.has(path)) wholeFileBoundaryPathsRef.current.add(path);
      }
      if (wholeFileBoundaryPathsRef.current.size) {
        if (wholeFileBoundaryTimerRef.current !== null) {
          window.clearTimeout(wholeFileBoundaryTimerRef.current);
        }
        wholeFileBoundaryTimerRef.current = window.setTimeout(() => {
          wholeFileBoundaryTimerRef.current = null;
          const pathsToFlush = Array.from(wholeFileBoundaryPathsRef.current);
          wholeFileBoundaryPathsRef.current.clear();
          void flushDeferredWholeFileSyncRef.current(pathsToFlush);
        }, OVERLEAF_WHOLE_FILE_SETTLE_MS);
      }
      if (wholeFileIdleTimerRef.current !== null) {
        window.clearTimeout(wholeFileIdleTimerRef.current);
      }
      wholeFileIdleTimerRef.current = window.setTimeout(() => {
        wholeFileIdleTimerRef.current = null;
        void flushDeferredWholeFileSyncRef.current();
      }, OVERLEAF_WHOLE_FILE_IDLE_MS);
    }
    // A save belonging only to a whole-file editor waits for a document
    // boundary (or the long quiet fallback) instead of downloading and merging
    // the Overleaf project after every serialized control change.
    if (!savedPaths.some((path) => !isWholeFileEditorPath(path))) return;
    let cancelled = false;
    let timer: number | null = null;
    const attempt = () => {
      if (cancelled) return;
      // If a sync ran moments ago, wait out the remainder instead of dropping
      // the push — dropping meant the edit sat here until something else
      // happened to sync, which is what made pushes feel like they never came.
      // The gap is a floor, not a delay: autosave fires about a second after
      // typing stops, and syncing on each of those meant asking Overleaf for
      // the whole project every couple of seconds, which is over its limit.
      const gap = overleafChannelLiveRef.current
        ? OVERLEAF_CHANNEL_SYNC_GAP_MS
        : OVERLEAF_MIN_SYNC_GAP_MS;
      const wait = gap - (Date.now() - lastAutoSyncRef.current);
      if (wait > 0) {
        timer = window.setTimeout(attempt, wait);
        return;
      }
      lastAutoSyncRef.current = Date.now();
      void overleafSyncRef.current({ auto: true });
    };
    timer = window.setTimeout(attempt, OVERLEAF_PUSH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [
    OVERLEAF_WHOLE_FILE_IDLE_MS,
    OVERLEAF_WHOLE_FILE_SETTLE_MS,
    captureSavedPaths,
    overleafLink,
    overleafSyncMode,
    saveGeneration,
    savedPathsRef,
  ]);

  // Manual mode never syncs on its own; it just watches for incoming work so
  // the toolbar can offer it, the way a repository shows commits to pull.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "manual" || !project?.root) {
      setOverleafRemoteChanges(false);
      return;
    }
    const projectRoot = project.root;
    let stopped = false;
    const check = async () => {
      try {
        const probe = await invoke<OverleafProbe>("overleaf_probe", { projectRoot });
        if (!stopped) setOverleafRemoteChanges(probe.changed);
      } catch {
        // Leave the badge as-is when the check cannot run.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [overleafLink, overleafSyncMode, project?.root]);

  // Auto-save a version after successful builds of Overleaf-linked projects,
  // at most every 2 minutes. Unlinked projects only version on explicit "Save
  // version" — never surprise-commit into a repo the user manages by hand.
  useEffect(() => {
    if (!build?.success || !overleafLink) return;
    const now = Date.now();
    if (now - lastAutoVersionRef.current < 120_000) return;
    lastAutoVersionRef.current = now;
    void invoke<string | null>("git_auto_commit", {
      message: "Auto-saved version",
      author: collabName.trim() || null,
    }).catch(() => {});
  }, [build, collabName, overleafLink]);

  return {
    overleafLink,
    overleafProjectLinked,
    overleafSyncing,
    overleafSyncMode,
    setOverleafSyncMode,
    overleafRemoteDelete,
    setOverleafRemoteDelete,
    overleafRemoteChanges,
    setOverleafRemoteChanges,
    overleafPickerOpen,
    setOverleafPickerOpen,
    overleafReviewOpen,
    setOverleafReviewOpen,
    overleafCollabOpen,
    setOverleafCollabOpen,
    overleafCollabTab,
    setOverleafCollabTab,
    conflictPath,
    setConflictPath,
    /** Read by callers that must reach the newest sync without re-subscribing. */
    overleafSyncRef,
    refreshOverleafLink,
    publishProjectToOverleaf,
    runOverleafSync,
    flushDeferredWholeFileSync,
    settleRemoteDeletes,
    openCurrentOverleafProject,
    jumpToOverleafPeer,
    overleafRealtime,
    overleafPresence,
    overleafChat,
    overleafComments,
    /** The comment handlers in App reach the newest actions through this ref. */
    overleafCommentsRef,
    overleafTrackChanges,
    overleafDocPaths,
    overleafEditorComments,
    overleafActiveCursors,
  };
}
