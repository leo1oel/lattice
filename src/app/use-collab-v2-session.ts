import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { notifyError } from "../telemetry/app-notify";
import { setError, setNotice } from "./notify";
import { confirmAction, toMessage } from "../app-utils";
import { playInterfaceSound } from "../telemetry/interface-sounds";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import { isPaperLibraryPath } from "../papers/paper-link";
import {
  clearPreCollabProjectRoot,
  resolvePreCollabProjectRoot,
} from "../collab/collab-return";
import {
  loadCollabDisplayName,
  loadCollabHost,
  mergeTextIntoYText,
  resolveCollabHost,
  saveCollabDisplayName,
  saveCollabHost,
  type CollabPeer,
  type CollabStatus,
  type EditorCollabSession,
} from "../collab/collab-session";
import { collabDeploymentOrigin } from "../collab/collab-config";
import { collabCredentialStore, type CollabCredentialStore } from "../collab/collab-credentials";
import { createProjectV2 } from "../collab/collab-import-v2";
import { isCollabEnabled } from "../collab/collab-feature-policy";
import { CollabControlErrorV2, CollabControlV2Client } from "../collab/collab-control-v2";
import {
  CollabProjectControllerV2,
  type CollabMaterializeCallbacksV2,
  type CollabProjectStatusV2,
} from "../collab/collab-project-v2";
import { mapCollabProjectStatusV2 } from "../collab/collab-status";
import { TextClientPermanentErrorV2 } from "../collab/collab-text-v2";
import { readRememberedV2Credential } from "../collab/collab-app-v2";
import {
  forgetCollabProjectV2,
  loadCollabProjectsV2,
  rememberCollabProjectV2,
  type CollabProjectRecordV2,
} from "../collab/collab-rooms";
import type { CollabDiskWriteQueue, CollabWorkspaceLease } from "../collab/collab-workspace-lease";
import type { CollabDialogMode } from "../collab/collab-dialog";
import type { CatalogV2 } from "../../protocol/collab-v2";
import type { RecentProject } from "../settings/app-settings";
import type { AssetPreview, ProjectSnapshot, RefreshProject } from "../app-types";

/** Notification source label for the live-collaboration surface. */
export const SHARE_SOURCE = "Live collaboration";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Rename or close a remembered room through its control API, retrying one catalog race. */
async function mutateRememberedRoomV2(
  record: CollabProjectRecordV2,
  store: CollabCredentialStore,
  endpoint: "project-rename" | "close-begin",
  body: Record<string, unknown> = {},
): Promise<void> {
  const credential = await readRememberedV2Credential(record, store);
  const control = new CollabControlV2Client(record.host, record.projectInstanceId, credential);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const catalog = await control.catalog();
    if (endpoint === "close-begin" && (catalog.lifecycle === "closing" || catalog.lifecycle === "closed")) return;
    try {
      await control.operation(endpoint, { ...body, operationId: crypto.randomUUID(), expectedCatalogRevision: catalog.catalogRevision });
      return;
    } catch (error) {
      if (error instanceof CollabControlErrorV2 && error.status === 409 && error.body.error === "catalog_revision_conflict" && attempt === 0) continue;
      if (endpoint === "close-begin" && error instanceof CollabControlErrorV2 && error.status === 409) {
        const refreshed = await control.catalog();
        if (refreshed.lifecycle === "closing" || refreshed.lifecycle === "closed") return;
      }
      throw error;
    }
  }
}

/** Leaving is one-at-a-time: a second request while one runs is dropped. */
async function leaveExclusively(leaving: RefObject<boolean>, leave: () => Promise<void>): Promise<void> {
  if (leaving.current) return;
  leaving.current = true;
  try {
    await leave();
  } finally {
    leaving.current = false;
  }
}

/**
 * What the v2 share borrows from App. The seam is `loadFile`: it binds the
 * editor to a shared Y.Text, so what it touches (the session, version, ready
 * flag, controller/lease/write-queue refs, per-path mutation counter) is
 * declared above it in App and passed down; everything needed to *start, run
 * and stop* the share lives here. Stable refs and setters are listed in deps anyway.
 */
export type CollabV2SessionDeps = {
  project: ProjectSnapshot | null;
  /** Imperative project identity; async work compares against it before committing. */
  projectRef: RefObject<ProjectSnapshot | null>;
  projectRootRef: RefObject<string | null>;
  projectOperationGenerationRef: RefObject<number>;
  activeFile: string;
  recentProjects: RecentProject[];
  /** The identity editor comments sign with, reused as the awareness participant id. */
  editorCommentAuthorId: string;
  activeCollabVersion: 2 | null;
  setActiveCollabVersion: (version: 2 | null) => void;
  collabSession: EditorCollabSession | null;
  setCollabSession: (session: EditorCollabSession | null) => void;
  collabSessionRef: RefObject<EditorCollabSession | null>;
  setCollabReady: (ready: boolean) => void;
  collabV2ControllerRef: RefObject<CollabProjectControllerV2 | null>;
  collabWorkspaceLeaseRef: RefObject<CollabWorkspaceLease | null>;
  collabDiskWriteQueueRef: RefObject<CollabDiskWriteQueue>;
  collabPathMutationGeneration: (path: string) => number;
  /** Detaches the primary editor's remote-text observer; see `loadFile`. */
  collabDetachRef: RefObject<(() => void) | null>;
  enterProjectRef: RefObject<((
    snapshot: ProjectSnapshot, options?: { skipCollabLifecycle?: boolean; deferInitialBuild?: boolean },
  ) => Promise<void>) | null>;
  setBusyLabel: (label: string | null) => void;
  startProjectTransition: () => Promise<boolean>;
  cancelProjectTransition: () => void;
  refreshProject: RefreshProject;
  loadFile: (path: string, options?: { collabController?: CollabProjectControllerV2 }) => Promise<boolean>;
  /** Disk callbacks for a v2 workspace; they fence App's editor buffers, so App owns them. */
  v2WorkspaceCallbacks: (lease: CollabWorkspaceLease) => CollabMaterializeCallbacksV2;
};

/**
 * The Lattice Share (Yjs v2) session: room state, the start / join / leave /
 * close lifecycle, catalog and permanent-error handling, and the two publish
 * paths (`publishTextToCollabV2`, `shareCreatedFileWithCollabV2`) that the rest
 * of App uses to keep collaborators in step with local writes.
 */
export function useCollabV2Session(deps: CollabV2SessionDeps) {
  const {
    project, projectRef, projectRootRef, projectOperationGenerationRef, activeFile, recentProjects,
    editorCommentAuthorId, activeCollabVersion, setActiveCollabVersion, collabSession, setCollabSession,
    collabSessionRef, setCollabReady, collabV2ControllerRef, collabWorkspaceLeaseRef, collabDiskWriteQueueRef,
    collabPathMutationGeneration, collabDetachRef, enterProjectRef, setBusyLabel, startProjectTransition,
    cancelProjectTransition, refreshProject, loadFile, v2WorkspaceCallbacks,
  } = deps;
  // Called here rather than taken from App: the Lingui macro only rewrites
  // `t` in the scope that destructured it from `useLingui()`.
  const { t } = useLingui();

  const [collabOpen, setCollabOpen] = useState(false);
  const [collabMode, setCollabMode] = useState<CollabDialogMode>("start");
  const [collabHost, setCollabHost] = useState(loadCollabHost);
  const [collabRoom, setCollabRoom] = useState("");
  const [collabInvite, setCollabInvite] = useState("");
  const [collabName, setCollabName] = useState(loadCollabDisplayName);
  const [collabProjectName, setCollabProjectName] = useState("Shared project");
  const [recentProjectsV2, setRecentProjectsV2] = useState<CollabProjectRecordV2[]>(loadCollabProjectsV2);
  const refreshRecentRooms = useCallback(() => { setRecentProjectsV2(loadCollabProjectsV2()); }, []);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>("disconnected");
  const [collabStatusDetail, setCollabStatusDetail] = useState<string | null>(null);
  const [collabPeerList, setCollabPeerList] = useState<CollabPeer[]>([]);
  const collabPeers = collabPeerList.length;
  const [collabFileCount, setCollabFileCount] = useState(0);
  const [collabRole, setCollabRole] = useState<"host" | "guest">("host");
  const collabRoleRef = useRef<"host" | "guest">("host");
  const collabV2InvitationRef = useRef("");
  const collabV2TreeSignatureRef = useRef<string | null>(null);
  const collabWorkspaceGenerationRef = useRef(0);
  const collabStartingRef = useRef(false);
  const collabStartGenerationRef = useRef(0);
  const collabLeavingRef = useRef(false);
  const preCollabProjectRootRef = useRef<string | null>(null);
  const showCollabStatus = useCallback((status: CollabStatus, detail: string | null = null) => {
    setCollabStatus(status);
    setCollabStatusDetail(detail);
  }, []);

  const clearCollabLocalState = useCallback(async (options: { flush?: boolean } = {}) => {
    collabStartGenerationRef.current += 1;
    collabStartingRef.current = false;
    const session = collabSessionRef.current;
    try {
      if (options.flush !== false) await session?.flush?.();
    } finally {
      if (collabSessionRef.current !== session) {
        session?.destroy();
      } else {
        collabWorkspaceGenerationRef.current += 1;
        collabWorkspaceLeaseRef.current = null;
        setCollabReady(false);
        collabDetachRef.current?.();
        collabDetachRef.current = null;
        if (session) session.destroy();
        collabV2ControllerRef.current = null;
        collabSessionRef.current = null;
        collabV2TreeSignatureRef.current = null;
        setCollabSession(null);
        setActiveCollabVersion(null);
        showCollabStatus("disconnected");
        setCollabPeerList([]);
        setCollabFileCount(0);
      }
    }
  }, [collabDetachRef, collabSessionRef, collabV2ControllerRef, collabWorkspaceLeaseRef, setActiveCollabVersion, setCollabReady, setCollabSession, showCollabStatus]);

  const restorePreCollabProject = useCallback(async () => {
    const prior = resolvePreCollabProjectRoot(preCollabProjectRootRef.current, recentProjects.map((item) => item.path));
    preCollabProjectRootRef.current = null;
    clearPreCollabProjectRoot();
    if (!prior) {
      setNotice("Share ended. Open one of your projects from the menu.", SHARE_SOURCE);
      return;
    }
    setBusyLabel("Returning to your project…");
    try {
      // Skip lifecycle so we do not re-enter leave/end while restoring.
      if (!await startProjectTransition()) return;
      await enterProjectRef.current?.(
        await invoke<ProjectSnapshot>("open_project", { path: prior }),
        { skipCollabLifecycle: true },
      );
      setNotice("Returned to your previous project", SHARE_SOURCE);
    } catch {
      cancelProjectTransition();
      setNotice("Share ended. Open one of your projects from the menu.", SHARE_SOURCE);
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProjectRef, recentProjects, setBusyLabel, startProjectTransition]);

  const endHostShareSession = useCallback((noticeText: string) => leaveExclusively(collabLeavingRef, async () => {
    const controller = activeCollabVersion === 2 && collabRoleRef.current === "host"
      ? collabV2ControllerRef.current
      : null;
    const expectedRoot = projectRef.current?.root;
    const projectGeneration = projectOperationGenerationRef.current;
    // Closing the drawer must not wait for a network round trip: start the
    // remote close now, then flush and tear down in the background.
    const remoteClose = controller?.close().then(() => true, () => false) ?? Promise.resolve(true);
    setCollabOpen(false);
    showCollabStatus("disconnected");
    setCollabPeerList([]);
    setNotice(noticeText);
    await controller?.flush().catch(() => undefined);
    await clearCollabLocalState({ flush: false }).catch(() => undefined);
    if (!await remoteClose) setNotice("Stopped sharing locally; the remote share may still be available", SHARE_SOURCE);
    // Peers edited these files; re-read the disk so the navigator, papers and
    // citations reflect it. A refresh failure must not block ending the share.
    if (expectedRoot) await refreshProject({ expectedRoot, generation: projectGeneration }).catch(() => undefined);
  }), [activeCollabVersion, clearCollabLocalState, collabV2ControllerRef, projectOperationGenerationRef, projectRef, refreshProject, showCollabStatus]);

  const leaveGuestShareSession = useCallback((noticeText: string, restorePrior: boolean) => leaveExclusively(collabLeavingRef, async () => {
    await clearCollabLocalState();
    setCollabOpen(false);
    setNotice(noticeText);
    if (restorePrior) {
      await restorePreCollabProject();
    } else {
      preCollabProjectRootRef.current = null;
      clearPreCollabProjectRoot();
    }
  }), [clearCollabLocalState, restorePreCollabProject]);

  /**
   * Open the joined project's first document and make sure the share is bound
   * to it. `loadFile` activates a shared document only if its load is still the
   * newest when the room syncs, so a slow open cannot steal the editor back.
   * Joining runs that load behind materialization, a project switch and a
   * refresh, so it is easily superseded, leaving the guest in the room with no
   * active document: no identity, no caret, every peer "not in a file right
   * now". One retry re-captures the generations after everything has settled.
   */
  const bindJoinedDocument = useCallback(async (controller: CollabProjectControllerV2, path: string) => {
    const opened = await loadFile(path, { collabController: controller });
    if (opened && controller.activePath === path) return;
    if (collabV2ControllerRef.current !== controller) return;
    await loadFile(path, { collabController: controller });
  }, [collabV2ControllerRef, loadFile]);

  /**
   * The session ended from the other side: the host removed this collaborator
   * or ended the room. Both revoke the credential, so say what happened, hand
   * back the guest's own project, and retire a room they can no longer enter.
   */
  const handleV2PermanentError = useCallback((error: Error) => {
    // File-scoped codes (a deleted file, a stale epoch) are recovered per file
    // and must not tear the session down.
    const code = error instanceof TextClientPermanentErrorV2 ? error.code : null;
    if (code !== "revoked" && code !== "project_closed") return;
    if (collabRoleRef.current === "host") return;
    const controller = collabV2ControllerRef.current;
    // Every open file has its own socket, fenced together: the first signal
    // tears the session down, and later ones find no active controller, so the
    // project is not restored and the closure announced repeatedly.
    if (!controller) return;
    forgetCollabProjectV2(controller.host, controller.room);
    refreshRecentRooms();
    void leaveGuestShareSession(
      code === "revoked"
        ? t`The host removed you from this share. Your own project is open again.`
        : t`The host ended this share. Your own project is open again.`,
      true,
    );
  }, [collabV2ControllerRef, leaveGuestShareSession, refreshRecentRooms, t]);

  /**
   * The host steps out without ending the room: collaborators keep editing and
   * the entry stays under Your shared rooms for rejoining or Close for everyone.
   * Shared by the Leave share button and by switching projects.
   */
  const leaveHostShareSession = useCallback(async () => {
    await clearCollabLocalState();
    setCollabOpen(false);
    refreshRecentRooms();
    setNotice("Left the share — it keeps running; rejoin it from Live collaboration", SHARE_SOURCE);
  }, [clearCollabLocalState, refreshRecentRooms]);

  const disconnectCollab = useCallback(() => {
    if (collabRoleRef.current === "host") void endHostShareSession("Stopped sharing");
    else void leaveGuestShareSession("Left the shared session", true);
  }, [endHostShareSession, leaveGuestShareSession]);

  const settleCollabBeforeProjectSwitch = useCallback(async (nextRoot: string) => {
    const session = collabSessionRef.current;
    if (!session) return;
    const currentRoot = projectRootRef.current;
    if (currentRoot && currentRoot === nextRoot) return;
    // Switching projects only detaches the host locally, like closing the app;
    // only "Stop sharing" ends the room for everyone. A guest leaves quietly.
    if (collabRoleRef.current === "host") await leaveHostShareSession();
    else await leaveGuestShareSession("Left the shared session", false);
  }, [collabSessionRef, leaveGuestShareSession, leaveHostShareSession, projectRootRef]);

  const mapV2Status = useCallback((status: CollabProjectStatusV2) => {
    // Start sharing owns the more useful phase-by-phase progress copy. Provider
    // status changes during openPath must not erase it or expose the live card
    // before setup has actually finished.
    if (collabStartingRef.current) return;
    const mapped = mapCollabProjectStatusV2(status);
    showCollabStatus(mapped.status, mapped.detail);
  }, [showCollabStatus]);

  /**
   * v2 catalog push (peer create/rename/delete, grants, lifecycle): keep the
   * file count live and refresh the tree when paths change. Remote deletion has
   * its own post-delete refresh that also fences stale editor buffers. The first
   * callback after join only records the baseline; materialization refreshes.
   */
  const handleV2Catalog = useCallback((catalog: CatalogV2) => {
    // A closed room is gone for good (every grant is revoked), so drop its
    // entry the moment the catalog says so, on whichever side sees it.
    if (catalog.lifecycle === "closing" || catalog.lifecycle === "closed") {
      const activeController = collabV2ControllerRef.current;
      const deployment = activeController?.host;
      if (deployment) {
        forgetCollabProjectV2(deployment, catalog.projectInstanceId);
        refreshRecentRooms();
      }
      // The catalog poll is the fallback for a guest who was offline when the
      // socket closed; either signal must leave the dead workspace too.
      if (collabRoleRef.current !== "host" && activeController?.room === catalog.projectInstanceId) {
        void leaveGuestShareSession(t`The host ended this share. Your own project is open again.`, true);
        return;
      }
    }
    const livePaths = catalog.files.filter((file) => file.state === "live").map((file) => file.path).sort();
    setCollabFileCount(livePaths.length);
    const signature = livePaths.join("\n");
    const previous = collabV2TreeSignatureRef.current;
    collabV2TreeSignatureRef.current = signature;
    if (previous !== null && previous !== signature) void refreshProject().catch(() => undefined);
  }, [collabV2ControllerRef, leaveGuestShareSession, refreshProject, refreshRecentRooms, t]);

  /**
   * Push a non-active text buffer into the v2 session and onto disk. Sideload,
   * so publishing never steals the active file (editor binding, awareness
   * path). Returns false when the file is not live in the share, so the caller
   * can fall back to a plain local write.
   *
   * Every caller must list this in its own dependency array: its identity tracks
   * `activeCollabVersion`, the one state value it reads, and a closure captured
   * while that was `null` answers `false` forever. `loadFile` can publish the
   * session a commit *before* the version, so a caller memoized only on
   * `collabSession` silently stops reaching collaborators for the whole share.
   *
   * `expectedMutationGeneration` is no substitute: evaluated fresh at call time
   * even from a stale closure, it only fences the disk write against a
   * rename/delete landing during `openPath`.
   */
  const publishTextToCollabV2 = useCallback(async (path: string, content: string, expectedMutationGeneration = collabPathMutationGeneration(path)): Promise<boolean> => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !controller || path.toLocaleLowerCase().endsWith(".tldr") || isSpreadsheetPath(path) || isPaperLibraryPath(path)) return false;
    if (!controller.hasTextPath(path)) return false;
    const ytext = await controller.openPath(path, "secondary", { sideload: true });
    // Minimal-span merge, not delete-all + insert-all: a peer's concurrent
    // edits outside the changed span survive, and the local origin keeps disk
    // observers from rewriting the file we are about to write ourselves.
    mergeTextIntoYText(ytext, content);
    const lease = collabWorkspaceLeaseRef.current;
    const projectRoot = lease?.projectRoot ?? projectRootRef.current;
    if (!projectRoot) throw new Error("The project closed before the file could be written.");
    const unchanged = () => expectedMutationGeneration === collabPathMutationGeneration(path);
    if (!unchanged()) return true;
    const write = () => invoke("write_project_file", { path, content: ytext.toString(), projectRoot });
    if (lease) await collabDiskWriteQueueRef.current.run(lease, path, () => unchanged() ? write() : Promise.resolve());
    else await write();
    return true;
  }, [activeCollabVersion, collabDiskWriteQueueRef, collabPathMutationGeneration, collabV2ControllerRef, collabWorkspaceLeaseRef, projectRootRef]);

  /**
   * Register a locally created file with the live v2 share: catalog create,
   * then content (a text seed, or a binary upload for figures). No-ops outside
   * a share; on failure the file stays local-only and a warning names it.
   */
  const shareCreatedFileWithCollabV2 = useCallback(async (path: string, kind: "text" | "binary" | "board" | "spreadsheet") => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !controller || isPaperLibraryPath(path)) return;
    try {
      if (kind === "binary") {
        const asset = await invoke<AssetPreview>("read_project_asset", { path });
        const bytes = base64ToBytes(asset.base64);
        const conflictWriter = {
          rename: async () => { throw new Error("Unexpected rename during binary publish"); },
          delete: async () => { throw new Error("Unexpected delete during binary publish"); },
          writeBinaryConflict: async (conflictPath: string, conflictBytes: Uint8Array, projectRoot: string) => {
            await collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, conflictPath, () => invoke("write_project_bytes", { path: conflictPath, base64Data: bytesToBase64(conflictBytes), projectRoot }));
          },
        };
        // Importing over an already-shared path is a content update, not a create.
        if (!controller.catalogFiles().some((entry) => entry.path === path && entry.state === "live")) {
          await controller.create(path, "binary");
        }
        await controller.replaceBinary(path, bytes, asset.mimeType, conflictWriter);
      } else {
        const seed = await invoke<string>("read_project_file", { path });
        // Structured editors keep live state beside the content text, so an
        // import over an existing live document leaves its shared doc as-is.
        if (controller.hasTextPath(path)) {
          if (kind === "text") await publishTextToCollabV2(path, seed);
        } else {
          await controller.create(path, kind, { seedText: seed });
        }
      }
    } catch (reason) {
      setError(`${path} was created locally but could not be shared: ${toMessage(reason)}. Restart the share to include it.`);
    }
  }, [activeCollabVersion, collabDiskWriteQueueRef, collabV2ControllerRef, collabWorkspaceLeaseRef, publishTextToCollabV2]);

  const startCollabShare = useCallback(() => {
    if (!isCollabEnabled() || collabStartingRef.current) return;
    if (!collabName.trim()) {
      setError("Enter your name before starting a share.", SHARE_SOURCE);
      setCollabOpen(true);
      return;
    }
    if (!collabProjectName.trim()) {
      setError("Enter a room name before starting a share.", SHARE_SOURCE);
      setCollabOpen(true);
      return;
    }
    if (!project) {
      setError("Open a project before starting live collaboration.", SHARE_SOURCE);
      return;
    }
    collabStartingRef.current = true;
    const startGeneration = ++collabStartGenerationRef.current;
    const isCurrentStart = () => collabStartGenerationRef.current === startGeneration;
    const assertCurrentStart = () => {
      if (!isCurrentStart()) throw new Error("Share start was canceled");
    };
    void (async () => {
      let controller: CollabProjectControllerV2 | null = null;
      showCollabStatus("connecting", t`Scanning project files…`);
      try {
        const resolved = resolveCollabHost(collabHost);
        saveCollabHost(resolved);
        saveCollabDisplayName(collabName.trim());
        const deployment = collabDeploymentOrigin(resolved);
        const nativeInventory = await invoke<{ files: Array<{ path: string; contentKind: "text" | "binary"; size: number }>; excluded: Array<{ pathOrPattern: string; reason: string }> }>("collab_project_inventory_v2");
        assertCurrentStart();
        if (nativeInventory.excluded.length) {
          const reasons: Record<string, string> = {
            "git-internals": t`Git internal data`,
            "app-private-state": t`Private app data`,
            "generated-directory": t`Generated directory`,
            "symlink-not-followed": t`Symbolic links are not followed`,
          };
          const details = nativeInventory.excluded.map(item => `• ${item.pathOrPattern} — ${reasons[item.reason] ?? item.reason}`).join("\n");
          if (!await confirmAction(t({ message: `Some project items won't be included in this share:\n\n${details}\n\nContinue sharing the remaining regular files?` }))) {
            showCollabStatus("disconnected");
            return;
          }
          assertCurrentStart();
        }
        const inventory = nativeInventory.files.map(item => ({ path: item.path, kind: item.contentKind }));
        const kinds = new Map(inventory.map((item) => [item.path, item.kind]));
        const store = collabCredentialStore();
        setCollabStatusDetail(t`Preparing ${inventory.length} project files…`);
        const record = await createProjectV2({
          deployment,
          projectName: collabProjectName.trim(),
          credentialStore: store,
          source: {
            inventory: async () => inventory,
            read: async (path) => {
              if (kinds.get(path) === "text") return new TextEncoder().encode(await invoke<string>("read_project_file", { path }));
              return base64ToBytes((await invoke<AssetPreview>("read_project_asset", { path })).base64);
            },
          },
          onPrepareProgress: (completed, total) => { if (isCurrentStart()) setCollabStatusDetail(t`Preparing project files… ${completed}/${total}`); },
          onProgress: (completed, total) => { if (isCurrentStart()) setCollabStatusDetail(t`Uploading project files… ${completed}/${total}`); },
          onRecord: async (created) => { const now = Date.now(); assertCurrentStart(); rememberCollabProjectV2({ version: 2, projectInstanceId: created.projectInstanceId, host: created.deployment, credentialRef: created.credentialRef, permission: "host", title: collabProjectName.trim(), projectRoot: project.root, createdAt: now, lastUsed: now }); },
        });
        assertCurrentStart();
        setCollabStatusDetail(t`Connecting to the live session…`);
        // Permanent socket errors can arrive as soon as the first document
        // opens, before the session is published below. Classify them using
        // the session being started rather than the previous session's role.
        collabRoleRef.current = "host";
        controller = await CollabProjectControllerV2.start({ deployment, projectInstanceId: record.projectInstanceId, credentialRef: record.credentialRef, credentialStore: store, permission: "host", onStatus: mapV2Status, onCatalog: handleV2Catalog, displayName: collabName, participantId: editorCommentAuthorId, onPeers: setCollabPeerList, onPermanentError: handleV2PermanentError });
        assertCurrentStart();
        const sharedTextPaths = controller.catalogTextPaths().filter((item) => !isPaperLibraryPath(item));
        const path = activeFile && sharedTextPaths.includes(activeFile) ? activeFile : sharedTextPaths[0];
        if (!path) throw new Error("The shared project has no text files");
        setCollabStatusDetail(t`Opening the shared document…`);
        await controller.openPath(path);
        assertCurrentStart();
        setCollabStatusDetail(t`Creating an invite…`);
        const invitation = await controller.createInvitation("write");
        assertCurrentStart();
        collabV2InvitationRef.current = invitation;
        const workspaceGeneration = ++collabWorkspaceGenerationRef.current;
        const lease: CollabWorkspaceLease = {
          projectRoot: project.root,
          generation: workspaceGeneration,
          isCurrent: () => collabWorkspaceGenerationRef.current === workspaceGeneration && projectRootRef.current === project.root,
        };
        collabWorkspaceLeaseRef.current = lease;
        controller.bindWorkspace(lease, v2WorkspaceCallbacks(lease));
        collabV2ControllerRef.current = controller;
        collabSessionRef.current = controller;
        collabRoleRef.current = "host";
        setCollabRole("host");
        setActiveCollabVersion(2);
        setCollabRoom(controller.room);
        setCollabSession(controller);
        setCollabFileCount(controller.fileCount());
        setCollabReady(true);
        setCollabStatusDetail(t`Finishing setup…`);
        await loadFile(path);
        assertCurrentStart();
        const inviteCopied = await writeText(invitation).then(() => true, () => false);
        setCollabStatus("synced");
        setNotice(inviteCopied ? "Started v2 project share · invite copied" : "Started v2 project share · use Copy invite to share it", SHARE_SOURCE);
        playInterfaceSound("collaboration-ready");
      } catch (reason) {
        // Read before cleanup: clearing the session bumps the start generation.
        const canceled = !isCurrentStart();
        if (controller) {
          if (collabV2ControllerRef.current === controller) await clearCollabLocalState().catch(() => undefined);
          else controller.destroy();
        }
        if (canceled) {
          if (!collabStartingRef.current && collabSessionRef.current === null) showCollabStatus("disconnected");
          return;
        }
        const detail = toMessage(reason);
        showCollabStatus("error", `${t`Import failed — retry Start sharing`}: ${detail}`);
        setError(detail, SHARE_SOURCE);
      } finally {
        if (isCurrentStart()) collabStartingRef.current = false;
      }
    })();
  }, [handleV2PermanentError, activeFile, clearCollabLocalState, collabHost, collabName, collabProjectName, collabSessionRef, collabV2ControllerRef, collabWorkspaceLeaseRef, editorCommentAuthorId, handleV2Catalog, loadFile, mapV2Status, project, projectRootRef, setActiveCollabVersion, setCollabReady, setCollabSession, showCollabStatus, t, v2WorkspaceCallbacks]);

  const copyCollabInvite = useCallback(async () => {
    // Minting the invitation is a network round trip; when it fails (offline,
    // host unreachable) the click must say so instead of leaving the previous
    // clipboard contents masquerading as a fresh invite.
    try {
      const controller = collabV2ControllerRef.current;
      if (activeCollabVersion === 2 && collabRoleRef.current === "host" && controller) {
        collabV2InvitationRef.current = await controller.createInvitation("write");
      }
      if (!collabV2InvitationRef.current) throw new Error("No collaboration invite is available");
      await writeText(collabV2InvitationRef.current);
      setNotice("Invite copied", SHARE_SOURCE);
      return true;
    } catch (reason) {
      notifyError(SHARE_SOURCE, "Could not copy the invite", { detail: toMessage(reason) });
      return false;
    }
  }, [activeCollabVersion, collabV2ControllerRef]);

  const removeCollabPeer = useCallback(async (peer: CollabPeer) => {
    const controller = collabV2ControllerRef.current;
    if (collabRoleRef.current !== "host" || !controller || !peer.grantId) return;
    try {
      await controller.revoke(peer.grantId);
      setCollabPeerList((current) => current.filter((candidate) => candidate.grantId !== peer.grantId));
      setNotice(`Removed ${peer.name} from the share`);
    } catch (reason) {
      setError(`Could not remove ${peer.name}: ${toMessage(reason)}`);
    }
  }, [collabV2ControllerRef]);

  const openCollabDialog = useCallback((mode: CollabDialogMode = "start") => {
    if (!isCollabEnabled()) return;
    // Only an explicit "join" opens Join; guard against a stray event object
    // (e.g. an onClick handler) landing here and leaving neither tab selected.
    setCollabMode(mode === "join" ? "join" : "start");
    setCollabHost(resolveCollabHost(collabHost));
    if (mode !== "join" && project) setCollabProjectName(project.manifest.name || project.root.split(/[/\\]/).filter(Boolean).pop() || "Shared project");
    refreshRecentRooms();
    setCollabOpen(true);
  }, [collabHost, project, refreshRecentRooms]);

  useEffect(() => {
    if (!collabSession) return;
    return () => {
      if (collabSessionRef.current === collabSession) {
        collabDetachRef.current?.();
        collabDetachRef.current = null;
      }
      void (collabSession.flush?.() ?? Promise.resolve())
        .catch(() => undefined)
        .finally(() => collabSession.destroy());
    };
  }, [collabDetachRef, collabSession, collabSessionRef]);

  const forgetRecentProjectV2 = useCallback((record: CollabProjectRecordV2) => {
    // Host rows deliberately have no local-only removal: discarding the host
    // credential would leave a live room that this device can no longer end.
    if (record.permission === "host") return;
    void (async () => {
      try {
        if (record.credentialRef) await collabCredentialStore().delete(record.credentialRef, record.projectInstanceId, record.host);
      } catch (reason) {
        setError(toMessage(reason));
        return;
      }
      forgetCollabProjectV2(record.host, record.projectInstanceId);
      refreshRecentRooms();
    })();
  }, [refreshRecentRooms]);

  const renameRecentProjectV2 = useCallback((record: CollabProjectRecordV2, name: string) => {
    const next = name.trim();
    if (!next || next === record.title) return;
    if (next.length > 80) {
      setError("Room names can be at most 80 characters.");
      return;
    }
    void (async () => {
      try {
        await mutateRememberedRoomV2(record, collabCredentialStore(), "project-rename", { name: next });
        rememberCollabProjectV2({ ...record, title: next, lastUsed: Date.now() });
        if (collabV2ControllerRef.current?.room === record.projectInstanceId) setCollabProjectName(next);
        refreshRecentRooms();
        setNotice(`Renamed the room to “${next}”`);
      } catch (reason) {
        setError(`Could not rename the room: ${toMessage(reason)}`);
      }
    })();
  }, [collabV2ControllerRef, refreshRecentRooms]);

  const closeRecentProjectV2 = useCallback((record: CollabProjectRecordV2) => {
    void (async () => {
      if (!await confirmAction(`Close “${record.title}” for everyone?\n\nExisting invitations will stop working and collaborators will be disconnected.`)) return;
      let remoteClosed = false;
      const store = collabCredentialStore();
      try {
        const activeController = collabV2ControllerRef.current;
        // Prefer the live host session: it already holds the host token in memory,
        // so Close does not need another Keychain round-trip.
        if (activeCollabVersion === 2 && collabRoleRef.current === "host" && activeController?.room === record.projectInstanceId) {
          await activeController.flush();
          await activeController.close();
          remoteClosed = true;
          await clearCollabLocalState({ flush: false });
          setCollabOpen(false);
          setCollabStatus("disconnected");
        } else {
          await mutateRememberedRoomV2(record, store, "close-begin");
          remoteClosed = true;
        }
        if (record.credentialRef) {
          await store.delete(record.credentialRef, record.projectInstanceId, record.host).catch(() => undefined);
        }
        forgetCollabProjectV2(record.host, record.projectInstanceId);
        refreshRecentRooms();
        setNotice(`Closed “${record.title}” for everyone`);
      } catch (reason) {
        const detail = toMessage(reason);
        setError(remoteClosed
          ? `The room was closed, but local cleanup did not finish: ${detail}. Keep this entry and retry Close to finish cleanup.`
          : `Could not close the room: ${detail}`);
      }
    })();
  }, [activeCollabVersion, clearCollabLocalState, collabV2ControllerRef, refreshRecentRooms]);

  return {
    collabOpen, setCollabOpen,
    collabMode, setCollabMode,
    collabHost,
    collabRoom, setCollabRoom,
    collabInvite, setCollabInvite,
    collabName, setCollabName,
    collabProjectName, setCollabProjectName,
    recentProjectsV2, refreshRecentRooms,
    collabStatus, setCollabStatus,
    collabStatusDetail,
    collabPeerList, setCollabPeerList,
    collabPeers,
    collabFileCount, setCollabFileCount,
    collabRole, setCollabRole,
    /** Read by the join/rejoin flows, which classify socket errors before publishing. */
    collabRoleRef,
    collabWorkspaceGenerationRef,
    preCollabProjectRootRef,
    clearCollabLocalState,
    leaveHostShareSession,
    bindJoinedDocument,
    handleV2PermanentError,
    disconnectCollab,
    settleCollabBeforeProjectSwitch,
    mapV2Status,
    handleV2Catalog,
    publishTextToCollabV2,
    shareCreatedFileWithCollabV2,
    startCollabShare,
    copyCollabInvite,
    removeCollabPeer,
    openCollabDialog,
    forgetRecentProjectV2,
    renameRecentProjectV2,
    closeRecentProjectV2,
  };
}
