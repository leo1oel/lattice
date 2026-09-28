import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadOverleafRemoteDelete, loadOverleafSyncMode, type OverleafRemoteDelete, type OverleafSyncMode } from "../settings/app-settings";
import { logAction } from "../telemetry/app-notify";
import { diagnosticInvoke } from "../telemetry/diagnostic-request";
import { setError, setNotice, setWarning } from "./notify";
import { subscribeTauriEvent } from "./effect-helpers";
import { confirmAction, isWholeFileEditorPath, overleafLinkMatchesSession, toMessage } from "../app-utils";
import { useOverleafRealtime, type OverleafRemoteTextContext } from "../overleaf/use-overleaf-realtime";
import { useOverleafChat } from "../overleaf/use-overleaf-chat";
import { useOverleafPresence, type PresenceUser } from "../overleaf/use-overleaf-presence";
import { useOverleafComments, type OverleafComments } from "../overleaf/use-overleaf-comments";
import { useOverleafTrackChanges } from "../overleaf/use-overleaf-track-changes";
import { type PresenceCursor } from "../overleaf/overleaf-cursors";
import type { OverleafCollabTab } from "../overleaf/overleaf-collab";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { EditorCollabSession } from "../collab/collab-session";
import { hasConflictMarkers } from "../history/conflict-markers";
import type {
  AssetPreview, BuildResult, EditorPosition, FileViewState, OverleafLink, OverleafProbe, OverleafStatus,
  OverleafSyncResult, PaperSummary, ProjectSnapshot, RefreshProject, ViewRestoreRequest,
} from "../app-types";

/** Marks a comment that lives on Overleaf rather than in this project; App's comment handlers route on it. */
export const OVERLEAF_COMMENT_PREFIX = "overleaf:";

export function projectOverleafEditorComments(
  threads: OverleafComments["threads"],
  anchors: OverleafComments["anchors"],
  docPaths: Map<string, string>,
  liveDocId: string | null,
  liveAnchors: Map<string, { threadId: string; position: number; quote: string }>,
): EditorComment[] {
  // REST supplies ownership for every file; the joined document's live ranges
  // are authoritative, including anchors removed since the REST snapshot.
  const mergedAnchors = new Map([...anchors].filter(([, anchor]) => anchor.docId !== liveDocId));
  if (liveDocId) {
    for (const [id, anchor] of liveAnchors) mergedAnchors.set(id, { ...anchor, docId: liveDocId });
  }
  return threads.flatMap((thread) => {
    const anchor = mergedAnchors.get(thread.id);
    const path = anchor && docPaths.get(anchor.docId);
    if (!anchor || !path) return [];
    const [first, ...rest] = thread.messages;
    return [{
      id: `${OVERLEAF_COMMENT_PREFIX}${thread.id}`, path,
      from: anchor.position, to: anchor.position + anchor.quote.length, quote: anchor.quote, prefix: "", suffix: "",
      body: first?.content ?? "", authorId: first?.authorEmail ?? "overleaf",
      authorName: first ? `${first.authorName} · Overleaf` : "Overleaf", resolved: thread.resolved,
      replies: rest.map((message) => ({
        id: message.id, authorId: message.authorEmail ?? "overleaf", authorName: message.authorName,
        body: message.content, createdAt: new Date(message.timestamp).toISOString(),
      })),
      createdAt: new Date(first?.timestamp ?? 0).toISOString(),
      updatedAt: new Date(thread.messages.at(-1)?.timestamp ?? 0).toISOString(),
    }];
  });
}

type OverleafSyncOptions = {
  auto?: boolean;
  observedRemoteVersion?: number | null;
  /** Whole-file editors normally stay protected; these paths are ready to flush. */
  includeWholeFilePaths?: readonly string[];
};

function isTransientOverleafTransportFailure(reason: unknown): boolean {
  return /could not reach overleaf|error decoding response body/i.test(toMessage(reason));
}

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
/** Cadence once the channel carries documents: only figures and new files remain, and each "yes" is a full download. */
const OVERLEAF_CHANNEL_POLL_MS = 45_000;
/**
 * Floor between full syncs: Overleaf answers 429 past ten project downloads a
 * minute, and a collaborator typing moves the version on every poll.
 */
const minimumSyncGap = (channelLive: boolean) => (channelLive ? 30_000 : 12_000);

type TimerRef = { current: number | null };

function clearTimer(timer: TimerRef) {
  if (timer.current !== null) window.clearTimeout(timer.current);
  timer.current = null;
}

/** (Re)start a one-shot timer held in a ref, replacing any pending run. */
function restartTimer(timer: TimerRef, delay: number, run: () => void) {
  clearTimer(timer);
  timer.current = window.setTimeout(() => {
    timer.current = null;
    run();
  }, delay);
}

/** The project's Overleaf link, and whether the signed-in session may use it. */
type OverleafLinkFor = { root: string; link: OverleafLink; active: boolean };

async function readOverleafLink(root: string): Promise<OverleafLinkFor | null> {
  const [status, link] = await Promise.all([invoke<OverleafStatus>("overleaf_status"), invoke<OverleafLink | null>("overleaf_link")]);
  return link ? {
    root,
    link: { ...link, host: link.host.trim() || status.host.trim() },
    active: status.connected && !link.paused && overleafLinkMatchesSession(status.host, link.host),
  } : null;
}

/**
 * Everything the Overleaf bridge borrows from App. App owns the three sync-gate
 * refs because its project transitions, declared long before this hook runs,
 * must be able to wait a sync out.
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
  setViewRestore: (request: ViewRestoreRequest) => void;
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
    observedRemoteVersion?: number | null, livePaths?: readonly string[], diagnosticOperationId?: string,
  ) => Promise<OverleafSyncResult>;
  save: () => Promise<boolean>;
  compile: () => Promise<void>;
  loadFile: (path: string, options?: { expectedProjectRoot?: string; projectGeneration?: number; canCommit?: () => boolean }) => Promise<boolean>;
  refreshProject: RefreshProject;
  openProjectFile: (path: string, line?: number) => Promise<void>;
  /** True while a sync owns the project; a switch has to wait it out. */
  overleafSyncingRef: RefObject<boolean>;
  /** Resolves when the in-flight Overleaf sync has finished its disk refresh. */
  overleafSyncSettledRef: RefObject<Promise<void> | null>;
  resolveOverleafSyncRef: RefObject<(() => void) | null>;
};

/** Apply only against the buffer and disk versions the live channel knows. */
export async function applyOverleafRemoteText(
  deps: Pick<OverleafWorkspaceDeps,
    "projectRef" | "projectOperationGenerationRef" | "activeFileRef" | "sourceRef" | "savedSourceRef"
    | "setSource" | "setSavedSource" | "setViewRestore" | "compile">,
  text: string,
  caret: number,
  context: OverleafRemoteTextContext,
): Promise<boolean> {
  const { path, projectRoot, baseContent } = context;
  const generation = deps.projectOperationGenerationRef.current;
  const isCurrent = () => context.isCurrent()
    && deps.projectRef.current?.root === projectRoot
    && deps.projectOperationGenerationRef.current === generation
    && deps.activeFileRef.current === path;
  if (!isCurrent() || deps.sourceRef.current !== baseContent) return false;
  const saved = deps.savedSourceRef.current;
  if (text === baseContent && saved !== baseContent) return false;
  // A compare-and-swap, never a merge against a guessed ancestor: a join
  // snapshot must not erase agent edits that have not reached the editor yet.
  // Ordinary sync, which has the real shared baseline, reconciles divergence.
  await invoke("write_project_file", { path, projectRoot, content: text, expectedContent: saved });
  // Typing during IPC stays dirty against its original saved base; the
  // ordinary editor save can merge it with the remote bytes now on disk.
  if (!isCurrent() || deps.sourceRef.current !== baseContent || deps.savedSourceRef.current !== saved) return false;
  deps.sourceRef.current = text;
  deps.savedSourceRef.current = text;
  deps.setSource(text);
  deps.setSavedSource(text);
  deps.setViewRestore({ path, cursor: caret, scrollTop: 0, id: crypto.randomUUID() });
  if (text !== saved) void deps.compile();
  return true;
}

/**
 * The Overleaf bridge: link discovery, syncing (manual, automatic and live),
 * the realtime channel and everything that rides it — presence, chat, comment
 * threads and tracked changes.
 */
export function useOverleafWorkspace(deps: OverleafWorkspaceDeps) {
  const {
    project, projectRef, projectOperationGenerationRef, activeFile, activeFileRef, activePaper, activeAsset,
    source, sourceRef, savedSourceRef, viewStateRef, editorPosition, editorPositionRef, build,
    saveGeneration, savedPathsRef, wholeFileEditingPaths, wholeFileDraftPaths, collabSession, collabName,
    runSharedOverleafSync, save, compile, loadFile, refreshProject, openProjectFile,
    overleafSyncingRef, overleafSyncSettledRef, resolveOverleafSyncRef,
  } = deps;
  const { t } = useLingui();

  const [overleafPickerOpen, setOverleafPickerOpen] = useState(false);
  // The link counts only while the root it was fetched for is still open (for
  // one render of a switch it is the old project's). Inactive links are kept,
  // so a paused one is not offered for upload as a second Overleaf project.
  const [overleafLinkFor, setOverleafLinkFor] = useState<OverleafLinkFor | null>(null);
  const overleafLinkLoadGenerationRef = useRef(0);
  const currentOverleafLink = overleafLinkFor?.root === project?.root ? overleafLinkFor : null;
  const overleafLink = currentOverleafLink?.active ? currentOverleafLink.link : null;
  const overleafProjectLinked = currentOverleafLink !== null;
  const [overleafSyncing, setOverleafSyncing] = useState(false);
  const [overleafSyncMode, setOverleafSyncMode] = useState<OverleafSyncMode>(loadOverleafSyncMode);
  const [overleafRemoteDelete, setOverleafRemoteDelete] = useState<OverleafRemoteDelete>(loadOverleafRemoteDelete);
  const [overleafRemoteChanges, setOverleafRemoteChanges] = useState(false);
  const [overleafReviewOpen, setOverleafReviewOpen] = useState(false);
  const [overleafCollabOpen, setOverleafCollabOpen] = useState(false);
  const [overleafCollabTab, setOverleafCollabTab] = useState<OverleafCollabTab>("comments");
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const overleafStartupCheckedRoot = useRef<string | null>(null);
  const overleafSyncRef = useRef<(options?: OverleafSyncOptions) => Promise<void>>(async () => {});
  const overleafTransportRetryRef = useRef(false);
  // Tokens distinguish edits arriving during a network-bound sync from the
  // batch it owns. A completed older pass must not retire the newer work.
  const externalChangesRef = useRef(new Map<string, symbol>());
  const [externalChangeGeneration, setExternalChangeGeneration] = useState(0);
  const resumeRealtimePathsRef = useRef<(paths: readonly string[]) => void>(() => {});
  const overleafCommentsRef = useRef<OverleafComments>(null as unknown as OverleafComments);
  /** Files the realtime channel owns; syncing must not touch them. */
  const overleafLivePathsRef = useRef<string[]>([]);
  const wholeFileEditingPathsRef = useRef<readonly string[]>(wholeFileEditingPaths);
  const wholeFileDraftPathsRef = useRef<readonly string[]>(wholeFileDraftPaths);
  const deferredWholeFilePathsRef = useRef(new Set<string>());
  const wholeFileIdleTimerRef = useRef<number | null>(null);
  const wholeFileBoundaryTimerRef = useRef<number | null>(null);
  const wholeFileBoundaryPathsRef = useRef(new Set<string>());
  const flushDeferredWholeFileSyncRef = useRef<(paths?: readonly string[]) => Promise<void>>(async () => {});
  /** Whether the realtime channel is up, for the poll loop to read. */
  const overleafChannelLiveRef = useRef(false);
  /** Path → Overleaf's id and kind, which is what its endpoints take. */
  const overleafEntitiesRef = useRef<Map<string, { id: string; kind: string }>>(new Map());
  const overleafRemoteDeleteRef = useRef<OverleafRemoteDelete>("ask");
  const lastAutoSyncRef = useRef(0);
  const lastAutoVersionRef = useRef(0);
  /** Every automatic sync stamps the rate-limit clock before it starts. */
  const autoSync = useCallback((options: Omit<OverleafSyncOptions, "auto"> = {}) => {
    lastAutoSyncRef.current = Date.now();
    return overleafSyncRef.current({ auto: true, ...options });
  }, []);
  /** A project-scoped operation stays current until the window switches projects. */
  const projectGuard = useCallback((root: string, generation: number) => () => (
    projectOperationGenerationRef.current === generation && projectRef.current?.root === root
  ), [projectOperationGenerationRef, projectRef]);
  /** Mark a sync (or publish) as owning the project, so a switch mid-sync queues behind it. Returns the release. */
  const holdSyncGate = useCallback(() => {
    overleafSyncingRef.current = true;
    setOverleafSyncing(true);
    overleafSyncSettledRef.current = new Promise<void>((resolve) => { resolveOverleafSyncRef.current = resolve; });
    return () => {
      overleafSyncingRef.current = false;
      setOverleafSyncing(false);
      const settle = resolveOverleafSyncRef.current;
      resolveOverleafSyncRef.current = null;
      overleafSyncSettledRef.current = null;
      settle?.();
    };
  }, [overleafSyncSettledRef, overleafSyncingRef, resolveOverleafSyncRef]);

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
    for (const path of paths.filter(isWholeFileEditorPath)) deferredWholeFilePathsRef.current.add(path);
    return paths;
  }, [savedPathsRef]);

  /** Read `root`'s link; a newer load or a project switch discards the answer. */
  const loadOverleafLink = useCallback((root: string) => {
    const generation = ++overleafLinkLoadGenerationRef.current;
    const latest = () => generation === overleafLinkLoadGenerationRef.current;
    void readOverleafLink(root).then(
      (linkFor) => { if (latest()) setOverleafLinkFor(linkFor); },
      // A project without the state file is simply not linked.
      () => { if (latest()) setOverleafLinkFor(null); },
    );
  }, []);

  // Whether the open project is linked drives the toolbar sync button and auto-sync.
  useEffect(() => {
    setOverleafLinkFor(null);
    if (project?.root) loadOverleafLink(project.root);
    return () => { overleafLinkLoadGenerationRef.current += 1; };
  }, [loadOverleafLink, project?.root]);

  /** Re-read the link after Settings changes it, so unlinking reaches every surface that rides it. */
  const refreshOverleafLink = useCallback(() => {
    const root = projectRef.current?.root;
    if (root) loadOverleafLink(root);
  }, [loadOverleafLink, projectRef]);

  const publishProjectToOverleaf = useCallback(async (projectName: string): Promise<boolean> => {
    if (!project || overleafSyncingRef.current) return false;
    const publishRoot = project.root;
    const stillCurrent = projectGuard(publishRoot, projectOperationGenerationRef.current);
    // Publishing mutates Overleaf and the local sync baseline, so it holds the sync gate.
    const release = holdSyncGate();
    return save().then(async (saved) => {
      if (!saved || !stillCurrent()) return false;
      const link = await invoke<OverleafLink>("overleaf_publish_project", { projectRoot: publishRoot, projectName });
      if (!stillCurrent()) return false;
      setOverleafLinkFor({ root: publishRoot, link, active: true });
      return true;
    }).finally(release);
  }, [holdSyncGate, overleafSyncingRef, project, projectGuard, projectOperationGenerationRef, save]);

  const openCurrentOverleafProject = useCallback(() => {
    if (!overleafLink) return;
    try {
      const url = new URL(`/project/${encodeURIComponent(overleafLink.projectId)}`, overleafLink.host);
      void openUrl(url.toString()).catch((reason) => {
        setError(`Could not open the project on Overleaf: ${toMessage(reason)}`);
      });
    } catch {
      setError("Could not open the project because its Overleaf host is invalid.");
    }
  }, [overleafLink]);

  /**
   * Files gone here but still on Overleaf. Deletion is never inferred from
   * absence: ordinary files obey the setting (leave, remove, or ask), app-owned
   * transient paths are cleaned silently. Either needs the entity id only the
   * realtime channel knows; without it the action waits for a later sync.
   */
  const settleRemoteDeletes = useCallback(async (paths: string[], projectRoot: string, generation: number, automatic = false) => {
    const stillCurrent = projectGuard(projectRoot, generation);
    if (!stillCurrent()) return;
    const policy = overleafRemoteDeleteRef.current;
    if (!automatic && policy === "never") return;
    const known = paths.flatMap((path) => {
      const entity = overleafEntitiesRef.current.get(path);
      return entity ? [{ path, entity }] : [];
    });
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
    for (const { path, entity } of known) {
      if (!stillCurrent()) return;
      try {
        await invoke("overleaf_delete_entity", { projectRoot, kind: entity.kind, entityId: entity.id });
      } catch (reason) {
        if (stillCurrent()) setError(t({ message: `Could not remove ${path} from Overleaf: ${toMessage(reason)}` }), "Overleaf");
        return;
      }
    }
    if (stillCurrent() && !automatic) {
      setNotice(known.length === 1
        ? t`Removed one file from Overleaf`
        : t({ message: `Removed ${known.length} files from Overleaf` }), "Overleaf");
    }
  }, [projectGuard, t]);

  const runOverleafSync = useCallback(async (options?: OverleafSyncOptions) => {
    if (!project || overleafSyncingRef.current) return;
    const syncRoot = project.root;
    const syncGeneration = projectOperationGenerationRef.current;
    const stillCurrent = projectGuard(syncRoot, syncGeneration);
    const release = holdSyncGate();
    const trace = logAction("Overleaf", "Sync", options?.auto ? "automatic" : "requested");
    // Saving below clears the dirty flag, cancelling the pending autosave
    // compile; remember it so the PDF still catches up with the edit.
    const hadUnsavedEdits = sourceRef.current !== savedSourceRef.current;
    try {
      if (!(await save())) return;
      if (!stillCurrent()) return;
      const livePaths = currentOverleafLivePaths(options?.auto ? options.includeWholeFilePaths : wholeFileEditingPathsRef.current);
      const externalBatch = new Map(externalChangesRef.current);
      const sharedSync = collabSession !== null;
      const result = sharedSync
        ? await runSharedOverleafSync(options?.observedRemoteVersion, livePaths, trace.id)
        : await diagnosticInvoke<OverleafSyncResult>("overleaf_sync", {
            projectRoot: syncRoot,
            live: livePaths,
            observedRemoteVersion: options?.observedRemoteVersion ?? null,
          }, { operationId: trace.id });
      if (!stillCurrent()) return;
      overleafTransportRetryRef.current = false;
      trace.enrich({
        automatic: options?.auto === true, shared: sharedSync, pulled: result.pulled.length, pushed: result.pushed.length,
        merged: result.merged.length, conflicts: result.conflicts.length, deleted_local: result.deletedLocal.length,
        read_only: result.readOnly === true,
      });
      // Pending whole-file paths omitted from `livePaths` went up with this
      // sync; forget them so a later blur does not download the project again.
      for (const path of deferredWholeFilePathsRef.current) {
        if (!livePaths.includes(path)) deferredWholeFilePathsRef.current.delete(path);
      }
      // Old versions uploaded PDF-inspection renders from an app-owned folder.
      // Remove those silently, outside the user's remote-delete preference.
      if (result.automaticRemoteDeletes?.length && !result.readOnly) {
        await settleRemoteDeletes(result.automaticRemoteDeletes, syncRoot, syncGeneration, true);
        if (!stillCurrent()) return;
      }
      // What happens to a file deleted here is the user's call (a setting).
      if (result.skippedRemoteDeletes.length) {
        await settleRemoteDeletes(result.skippedRemoteDeletes, syncRoot, syncGeneration);
        if (!stillCurrent()) return;
      }
      // Name files too big for Overleaf; otherwise they look synced and the
      // absence is only discovered from the other side.
      if (result.skippedLarge?.length) {
        setWarning(`Too large for Overleaf, so left on this machine: ${result.skippedLarge.join(", ")}.`, "Overleaf");
      }
      // Merged and conflicted files were rewritten on disk like pulled ones;
      // the editor must reload them or it would save over the incoming edits.
      const changedOnDisk = new Set([
        ...result.pulled,
        ...result.merged,
        ...result.conflicts.map((item) => item.path),
        // A disk-only edit can be pushed without a pull. The editor still
        // needs those bytes before it can safely rejoin the realtime room.
        ...[...externalBatch.keys()].filter((path) => !livePaths.includes(path)
          && !result.deletedLocal.includes(path) && !result.skippedRemoteDeletes.includes(path)),
      ]);
      if (result.conflicts.length) {
        // Only a file with markers has spots to resolve; for a figure or PDF,
        // say plainly that both versions are sitting on disk. A later disk
        // write can supersede the snapshot, so never demand choices for a clean
        // file; an unreadable one goes to the resolver, which reports it.
        const marked: OverleafSyncResult["conflicts"] = [];
        for (const item of result.conflicts.filter((conflict) => conflict.markers !== false)) {
          const content = await invoke<string>("read_project_file", { path: item.path, projectRoot: syncRoot }).catch(() => null);
          if (content === null || hasConflictMarkers(content)) marked.push(item);
          if (!stillCurrent()) return;
        }
        const whole = result.conflicts.filter((item) => item.markers === false);
        const names = (items: typeof marked) => items.map((item) => item.path).join(", ");
        const parts = [
          marked.length ? `Overleaf sync could not combine: ${names(marked)}. `
            + "Both versions are kept — resolve each spot to finish. "
            + "Your untouched version is also saved beside it in the “(local conflict …)” files, "
            + "and nothing uploads until the conflicts are settled." : "",
          whole.length ? `Changed in both places and impossible to combine: ${names(whole)}. `
            + "Overleaf's version is now the one in the project, and yours is kept beside it "
            + "in the “(local conflict …)” files — keep whichever you want and delete the other." : "",
        ].filter(Boolean);
        if (parts.length) setError(parts.join(" "));
        // Only worth opening for a file that actually has markers in it.
        if (marked[0]) setConflictPath(marked[0].path);
      }
      let reloadBlockedPath: string | null = null;
      if (changedOnDisk.size || result.deletedLocal.length) {
        await refreshProject({ expectedRoot: syncRoot, generation: syncGeneration });
        if (!stillCurrent()) return;
        // Navigation continues during the sync: reload the file active now.
        const currentActiveFile = activeFileRef.current;
        if (currentActiveFile && changedOnDisk.has(currentActiveFile)) {
          const buffer = sourceRef.current;
          const reloaded = await loadFile(currentActiveFile, {
            expectedProjectRoot: syncRoot,
            projectGeneration: syncGeneration,
            canCommit: () => activeFileRef.current === currentActiveFile
              && sourceRef.current === buffer && sourceRef.current === savedSourceRef.current,
          });
          if (!reloaded) reloadBlockedPath = currentActiveFile;
          if (!stillCurrent()) return;
        }
      }
      // A pushed agent checkpoint already owns its build (and manual build mode
      // stays manual), but flushed unsaved edits lost their autosave compile.
      const incoming = result.pulled.length > 0 || result.merged.length > 0
        || result.conflicts.length > 0 || result.deletedLocal.length > 0;
      if (incoming || hadUnsavedEdits) {
        await compile();
        if (!stillCurrent()) return;
      }
      // Rejoin realtime for what this pass settled. External edits count only
      // if no newer edit replaced their token; anything still pending, blocked,
      // conflicted, deleted or left behind stays out.
      const reconciled = new Set([...result.pushed, ...result.pulled, ...result.merged]);
      for (const [path, token] of externalBatch) {
        if (path === reloadBlockedPath || livePaths.includes(path) || externalChangesRef.current.get(path) !== token) continue;
        externalChangesRef.current.delete(path);
        reconciled.add(path);
      }
      for (const path of [
        ...externalChangesRef.current.keys(), ...(reloadBlockedPath ? [reloadBlockedPath] : []),
        ...result.conflicts.map((conflict) => conflict.path),
        ...result.deletedLocal, ...result.skippedRemoteDeletes, ...(result.skippedLarge ?? []),
      ]) reconciled.delete(path);
      if (!result.readOnly) resumeRealtimePathsRef.current([...reconciled]);
      if (result.pulled.length || result.pushed.length || result.merged.length) {
        const parts = [`pulled ${result.pulled.length}`, `pushed ${result.pushed.length}`];
        if (result.merged.length) parts.push(`merged ${result.merged.length}`);
        trace.ok(`Overleaf: ${parts.join(", ")}.`);
      } else if (!options?.auto) {
        trace.ok("Overleaf: already up to date.");
      } else {
        // A quiet background no-op still logs, so a gap in sync history is explained.
        trace.finish("success", "Overleaf: already up to date.");
      }
      // Only a real content change becomes a version: committing a no-op woke
      // the filesystem watcher and reloaded unrelated previews.
      if (incoming || hadUnsavedEdits || result.pushed.length > 0) {
        void invoke<string | null>("git_auto_commit", {
          message: "Overleaf sync", author: collabName.trim() || null, projectRoot: syncRoot,
        }).catch(() => {});
      }
      refreshOverleafLink();
    } catch (reason) {
      if (stillCurrent()) {
        if (options?.auto && isTransientOverleafTransportFailure(reason)) {
          // The live loop retries on its rate-limited cadence: retrying now
          // risks another 429, and a toast for a brief outage interrupts work.
          overleafTransportRetryRef.current = true;
          trace.enrich({ retry_scheduled: true });
          trace.fail(reason, { toast: false });
        } else {
          trace.fail(reason);
        }
      }
    } finally {
      trace.finish("cancelled", t`Overleaf sync cancelled`);
      release();
    }
  }, [
    activeFileRef, collabName, collabSession, compile, currentOverleafLivePaths, holdSyncGate, loadFile,
    overleafSyncingRef, project, projectGuard, projectOperationGenerationRef, refreshOverleafLink, refreshProject,
    runSharedOverleafSync, save, savedSourceRef, settleRemoteDeletes, sourceRef, t,
  ]);

  overleafSyncRef.current = runOverleafSync;

  const flushDeferredWholeFileSync = useCallback(async (paths?: readonly string[]) => {
    if (!overleafLink || overleafSyncMode !== "live" || !project?.root) return;
    captureSavedPaths();
    const deferred = deferredWholeFilePathsRef.current;
    const requested = paths ?? Array.from(deferred);
    const drafts = new Set(wholeFileDraftPathsRef.current);
    const ready = requested.filter((path) => deferred.has(path) && !drafts.has(path));
    if (!ready.length) {
      if (requested.some((path) => deferred.has(path))) {
        restartTimer(wholeFileIdleTimerRef, OVERLEAF_WHOLE_FILE_SETTLE_MS, () => void flushDeferredWholeFileSyncRef.current(requested));
      }
      return;
    }
    const syncRoot = project.root;
    if (overleafSyncingRef.current) await overleafSyncSettledRef.current;
    if (projectRef.current?.root !== syncRoot) return;
    const pathsToSync = ready.filter((path) => deferred.has(path));
    if (pathsToSync.length) await autoSync({ includeWholeFilePaths: pathsToSync });
  }, [autoSync, captureSavedPaths, overleafLink, overleafSyncMode, overleafSyncSettledRef, overleafSyncingRef, project?.root, projectRef]);
  useLayoutEffect(() => {
    flushDeferredWholeFileSyncRef.current = flushDeferredWholeFileSync;
  }, [flushDeferredWholeFileSync]);

  /** Sync the whole-file paths whose editors just closed, once cleanup writes settle. */
  const flushBoundaryPathsSoon = useCallback(() => {
    restartTimer(wholeFileBoundaryTimerRef, OVERLEAF_WHOLE_FILE_SETTLE_MS, () => {
      const pathsToFlush = Array.from(wholeFileBoundaryPathsRef.current);
      wholeFileBoundaryPathsRef.current.clear();
      void flushDeferredWholeFileSyncRef.current(pathsToFlush);
    });
  }, []);

  const previousWholeFileEditingPathsRef = useRef<readonly string[]>(wholeFileEditingPaths);
  useEffect(() => {
    const editing = new Set(wholeFileEditingPaths);
    const left = previousWholeFileEditingPathsRef.current.filter((path) => !editing.has(path));
    previousWholeFileEditingPathsRef.current = wholeFileEditingPaths;
    // A document switch can batch with the editor's final persistence update,
    // so capture that path here rather than rely on the save-generation effect.
    for (const path of left) {
      if (savedPathsRef.current.delete(path)) deferredWholeFilePathsRef.current.add(path);
    }
    const pending = left.filter((path) => deferredWholeFilePathsRef.current.has(path));
    if (!pending.length) return;
    for (const path of pending) wholeFileBoundaryPathsRef.current.add(path);
    flushBoundaryPathsSoon();
  }, [flushBoundaryPathsSoon, savedPathsRef, wholeFileEditingPaths]);

  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live") return;
    const onBlur = () => restartTimer(wholeFileBoundaryTimerRef, OVERLEAF_WHOLE_FILE_SETTLE_MS, () => void flushDeferredWholeFileSyncRef.current());
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [overleafLink, overleafSyncMode]);

  // Nothing queued for one project may carry over to the next.
  useEffect(() => {
    const clearProjectSyncState = () => {
      overleafTransportRetryRef.current = false;
      externalChangesRef.current.clear();
      deferredWholeFilePathsRef.current.clear();
      wholeFileBoundaryPathsRef.current.clear();
      savedPathsRef.current.clear();
      clearTimer(wholeFileIdleTimerRef);
      clearTimer(wholeFileBoundaryTimerRef);
    };
    clearProjectSyncState();
    return clearProjectSyncState;
  }, [project?.root, savedPathsRef]);

  // Live mode keeps a linked project current: "has your history moved?" is a
  // small JSON call every few seconds; the full sync follows only on a yes.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || !project?.root) return;
    const projectRoot = project.root;
    let stopped = false;
    const timer: TimerRef = { current: null };
    let running = false;
    // Backs off when Overleaf pushes back, and stays slow without a version to compare.
    const baseWait = () => overleafChannelLiveRef.current ? OVERLEAF_CHANNEL_POLL_MS : OVERLEAF_LIVE_POLL_MS;
    let wait = baseWait();
    const tick = async () => {
      if (stopped || running) return;
      clearTimer(timer);
      running = true;
      try {
        if (!overleafSyncingRef.current) {
          const probe = await invoke<OverleafProbe>("overleaf_probe", { projectRoot });
          wait = probe.versionKnown ? baseWait() : OVERLEAF_BLIND_POLL_MS;
          const sinceLastSync = Date.now() - lastAutoSyncRef.current;
          const gapElapsed = sinceLastSync >= minimumSyncGap(overleafChannelLiveRef.current);
          const retry = overleafTransportRetryRef.current || externalChangesRef.current.size > 0;
          if (stopped) return;
          if (retry && gapElapsed) {
            await autoSync();
          } else if (!probe.versionKnown) {
            // No change signal: sync on a slow clock instead.
            if (sinceLastSync >= OVERLEAF_BLIND_POLL_MS) await autoSync();
          } else if (probe.changed && gapElapsed) {
            await autoSync({ observedRemoteVersion: probe.remoteVersion });
          }
        }
      } catch (reason) {
        // A 429 means we are asking too often: ease off sharply.
        wait = /429|Too Many Requests/i.test(String(reason))
          ? Math.min(wait * 4, 5 * 60_000)
          : Math.min(Math.max(wait * 2, baseWait()), 60_000);
      }
      running = false;
      if (!stopped) restartTimer(timer, wait, () => void tick());
    };
    void tick();
    // Coming back from the browser is when stale content is most obvious.
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearTimer(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [autoSync, overleafLink, overleafSyncMode, overleafSyncingRef, project?.root]);

  // Editing through Overleaf's own channel. Documents stay off during a Lattice
  // share, whose Yjs session already owns the editor.
  const overleafRealtime = useOverleafRealtime({
    enabled: overleafLink !== null,
    documents: overleafSyncMode === "live" && !collabSession,
    projectRoot: project?.root ?? null,
    // Whole-file editors (slides, boards, sheets) serialize at once; character OT would compete.
    activeFile: isWholeFileEditorPath(activeFile) ? null : activeFile,
    readCaret: () => viewStateRef.current.get(activeFileRef.current ?? "")?.text?.cursor ?? 0,
    onRemoteText: (text, caret, context) => applyOverleafRemoteText(deps, text, caret, context),
    onNotice: (message) => setNotice(message),
    onNeedsSync: (paths) => {
      for (const path of paths) externalChangesRef.current.set(path, Symbol());
      setExternalChangeGeneration((generation) => generation + 1);
    },
  });
  useLayoutEffect(() => {
    resumeRealtimePathsRef.current = overleafRealtime.resumePaths;
  }, [overleafRealtime.resumePaths]);
  // The poll loop and the sync read these mid-flight. "Channel live" means
  // carrying documents: in manual mode it stays up for chat alone.
  overleafRemoteDeleteRef.current = overleafRemoteDelete;
  overleafEntitiesRef.current = overleafRealtime.entities;
  overleafChannelLiveRef.current = overleafRealtime.status === "live" && overleafSyncMode === "live" && !collabSession;
  overleafLivePathsRef.current = overleafRealtime.livePaths;

  /**
   * Push after the quiet period, waiting out the rest of the sync gap rather
   * than dropping the push. `gate` can hold it ("wait", rechecked each second)
   * or give it up ("drop"). Returns the cancel.
   */
  const schedulePush = useCallback((gate: () => "go" | "wait" | "drop" = () => "go") => {
    let timer = 0;
    const attempt = () => {
      const verdict = gate();
      if (verdict === "drop") return;
      const wait = verdict === "wait" ? 1_000 : minimumSyncGap(overleafChannelLiveRef.current) - (Date.now() - lastAutoSyncRef.current);
      if (wait > 0) timer = window.setTimeout(attempt, wait);
      else void autoSync();
    };
    timer = window.setTimeout(attempt, OVERLEAF_PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoSync]);

  // Disk writes do not bump saveGeneration; give them the same quiet period,
  // held while another sync or an unacknowledged OT operation owns the file.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || !externalChangesRef.current.size) return;
    return schedulePush(() => {
      const pending = [...externalChangesRef.current.keys()];
      if (!pending.length) return "drop";
      return overleafSyncingRef.current || pending.some((path) => overleafLivePathsRef.current.includes(path)) ? "wait" : "go";
    });
  }, [externalChangeGeneration, overleafLink, overleafSyncMode, overleafSyncingRef, project?.root, schedulePush]);

  // On first open, probe before downloading the whole project. Wait for
  // joinProject: it records the root folder id uploads require and lets the
  // probe exclude realtime-owned documents. A failed probe means a full sync.
  useEffect(() => {
    const projectRoot = project?.root;
    if (!projectRoot) return;
    if (!overleafLink || overleafSyncMode !== "live") {
      if (overleafStartupCheckedRoot.current === projectRoot) overleafStartupCheckedRoot.current = null;
      return;
    }
    if (!["live", "error"].includes(overleafRealtime.status) || overleafStartupCheckedRoot.current === projectRoot) return;
    overleafStartupCheckedRoot.current = projectRoot;
    let cancelled = false;
    const linkGeneration = overleafLinkLoadGenerationRef.current;
    const stillCurrent = () => !cancelled
      && projectRef.current?.root === projectRoot && overleafLinkLoadGenerationRef.current === linkGeneration;
    void invoke<OverleafProbe>("overleaf_probe", { projectRoot, checkLocal: true, live: currentOverleafLivePaths() }).then((probe) => {
      if (!stillCurrent() || (probe.versionKnown && !probe.changed && !probe.localChanged)) return;
      void autoSync({ observedRemoteVersion: probe.remoteVersion });
    }).catch(() => {
      if (stillCurrent()) void autoSync();
    });
    return () => { cancelled = true; };
  }, [autoSync, currentOverleafLivePaths, overleafLink, overleafRealtime.status, overleafSyncMode, project?.root, projectRef]);

  // The channel carries what presence cannot get elsewhere: our connection id,
  // and which file each document id is (rebuilt on every tree change).
  const [overleafSelfId, setOverleafSelfId] = useState<string | null>(null);
  const [overleafDocPaths, setOverleafDocPaths] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (overleafLink === null || !project?.root) {
      setOverleafSelfId(null);
      setOverleafDocPaths(new Map());
      return;
    }
    const projectRoot = project.root;
    return subscribeTauriEvent<{ projectRoot: string; type: string; publicId?: string; docs?: { id: string; path: string }[] }>(
      "overleaf-realtime",
      (payload) => {
        if (payload.projectRoot !== projectRoot) return;
        if (payload.type === "connected" && payload.publicId) {
          setOverleafSelfId(payload.publicId);
        } else if ((payload.type === "projectJoined" || payload.type === "treeChanged") && payload.docs) {
          setOverleafDocPaths(new Map(payload.docs.map((doc) => [doc.id, doc.path])));
        } else if (payload.type === "disconnected") {
          setOverleafSelfId(null);
        }
      },
    );
  }, [overleafLink, project?.root]);

  const overleafPresence = useOverleafPresence({
    // An unlinked project has no presence scope, or the last roster outlives a switch.
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

  // Publishing is the only way an already-open browser sees our caret.
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
    if (!docId || activePaper || activeAsset || overleafDocPaths.get(docId) !== activeFile) return [];
    return overleafPresence.peers
      .filter((peer): peer is PresenceUser & { row: number; column: number } => (
        peer.docId === docId && peer.row !== null && peer.column !== null
      ))
      .map(({ name, hue, row, column }) => ({ name: name || "Anonymous", hue, row, column }));
  }, [activeAsset, activeFile, activePaper, overleafDocPaths, overleafPresence.peers, overleafRealtime.docId]);

  // Chat, comment threads and suggestions ride the linked project's channel.
  const overleafChannel = { enabled: overleafLink !== null, projectRoot: project?.root ?? null };
  const overleafChat = useOverleafChat(overleafChannel);

  // Where each thread sits in the live document: the channel's copy moves with
  // typing, while the REST snapshot points at where the words used to be.
  const overleafAnchors = useMemo(
    () => new Map(overleafRealtime.comments.map((range) => [range.threadId, range])),
    [overleafRealtime.comments],
  );
  const overleafComments = useOverleafComments({
    ...overleafChannel,
    docId: overleafRealtime.docId,
    anchored: useMemo(() => overleafRealtime.comments.map((range) => range.threadId), [overleafRealtime.comments]),
    anchor: overleafRealtime.anchorComment,
  });

  // Overleaf's threads dressed as editor comments, so they highlight and answer
  // in place; the id prefix routes replies to Overleaf, not the comments file.
  const overleafEditorComments = useMemo(() => projectOverleafEditorComments(
    overleafComments.threads, overleafComments.anchors, overleafDocPaths, overleafRealtime.docId, overleafAnchors,
  ), [overleafComments.threads, overleafComments.anchors, overleafDocPaths, overleafRealtime.docId, overleafAnchors]);

  // Acting on a suggestion reports no operation, so the document is re-read afterwards.
  const overleafTrackChanges = useOverleafTrackChanges({
    ...overleafChannel,
    docId: overleafRealtime.docId,
    reserveOperation: overleafRealtime.reserveOperation,
    noteReservedOperationUnknown: overleafRealtime.noteReservedOperationUnknown,
    settledVersion: overleafRealtime.settledVersion,
    changes: overleafRealtime.changes,
    canAct: overleafRealtime.canWrite,
    reload: overleafRealtime.reload,
  });
  // App's comment handlers are declared before this hook runs; they read the newest actions here.
  overleafCommentsRef.current = overleafComments;

  // Keep the badge quiet while someone is reading the conversation.
  const { messages: overleafChatMessages, markRead: markOverleafChatRead } = overleafChat;
  useEffect(() => {
    if (overleafCollabOpen && overleafCollabTab === "chat") markOverleafChatRead();
  }, [overleafCollabOpen, overleafCollabTab, overleafChatMessages, markOverleafChatRead]);

  // Everything typed goes to the live channel, which ignores text it already
  // has. The hook's return object is rebuilt every render; depend on members.
  const { liveFile: overleafLiveFile, pushLocal: overleafPushLocal } = overleafRealtime;
  useEffect(() => {
    if (!overleafLiveFile) return;
    overleafPushLocal(source);
  }, [overleafLiveFile, overleafPushLocal, source]);

  // A live channel that could not start is otherwise invisible. Say so once.
  const overleafRealtimeNotified = useRef<string | null>(null);
  useEffect(() => {
    const detail = overleafRealtime.detail;
    if (overleafRealtime.status !== "error" || !detail || overleafRealtimeNotified.current === detail) return;
    overleafRealtimeNotified.current = detail;
    setNotice(`Live editing with Overleaf could not start (${detail}). Your project still syncs every few seconds.`);
  }, [overleafRealtime.detail, overleafRealtime.status]);

  // Live mode also pushes, keyed off *saves*: autosave clears the dirty flag
  // long before any sensible push delay, so watching dirty text cancelled it.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || saveGeneration === 0) return;
    const savedPaths = captureSavedPaths();
    const wholeFilePaths = savedPaths.filter(isWholeFileEditorPath);
    if (wholeFilePaths.length) {
      const editing = new Set(wholeFileEditingPathsRef.current);
      for (const path of wholeFilePaths) {
        if (!editing.has(path)) wholeFileBoundaryPathsRef.current.add(path);
      }
      if (wholeFileBoundaryPathsRef.current.size) flushBoundaryPathsSoon();
      restartTimer(wholeFileIdleTimerRef, OVERLEAF_WHOLE_FILE_IDLE_MS, () => void flushDeferredWholeFileSyncRef.current());
    }
    // Whole-file saves wait for a document boundary (or the idle fallback)
    // instead of a project download after every serialized control change.
    if (!savedPaths.some((path) => !isWholeFileEditorPath(path))) return;
    return schedulePush();
  }, [captureSavedPaths, flushBoundaryPathsSoon, overleafLink, overleafSyncMode, saveGeneration, savedPathsRef, schedulePush]);

  // Manual mode never syncs on its own; it only badges incoming work.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "manual" || !project?.root) {
      setOverleafRemoteChanges(false);
      return;
    }
    const projectRoot = project.root;
    let stopped = false;
    // A check that cannot run leaves the badge as it was.
    const check = () => invoke<OverleafProbe>("overleaf_probe", { projectRoot }).then((probe) => {
      if (!stopped) setOverleafRemoteChanges(probe.changed);
    }, () => undefined);
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [overleafLink, overleafSyncMode, project?.root]);

  // Version successful builds of linked projects at most every 2 minutes.
  // Unlinked projects never get surprise commits in a repo managed by hand.
  useEffect(() => {
    if (!build?.success || !overleafLink) return;
    const now = Date.now();
    if (now - lastAutoVersionRef.current < 120_000) return;
    lastAutoVersionRef.current = now;
    void invoke<string | null>("git_auto_commit", { message: "Auto-saved version", author: collabName.trim() || null }).catch(() => {});
  }, [build, collabName, overleafLink]);

  return {
    overleafLink, overleafProjectLinked, overleafSyncing,
    overleafSyncMode, setOverleafSyncMode,
    overleafRemoteDelete, setOverleafRemoteDelete,
    overleafRemoteChanges, setOverleafRemoteChanges,
    overleafPickerOpen, setOverleafPickerOpen,
    overleafReviewOpen, setOverleafReviewOpen,
    overleafCollabOpen, setOverleafCollabOpen,
    overleafCollabTab, setOverleafCollabTab,
    conflictPath, setConflictPath,
    /** Read by callers that must reach the newest sync without re-subscribing. */
    overleafSyncRef,
    refreshOverleafLink, publishProjectToOverleaf, runOverleafSync, flushDeferredWholeFileSync, settleRemoteDeletes,
    openCurrentOverleafProject, jumpToOverleafPeer,
    overleafRealtime, overleafPresence, overleafChat, overleafComments,
    /** The comment handlers in App reach the newest actions through this ref. */
    overleafCommentsRef,
    overleafTrackChanges, overleafDocPaths, overleafEditorComments, overleafActiveCursors,
  };
}
