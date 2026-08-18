import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { notifyError } from "../telemetry/app-notify";
import { setError, setNotice } from "./notify";
import { confirmAction, toMessage } from "../app-utils";
import { playInterfaceSound } from "../telemetry/interface-sounds";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
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
import { collabCredentialStore } from "../collab/collab-credentials";
import { createProjectV2 } from "../collab/collab-import-v2";
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
import type { AssetPreview, ProjectSnapshot } from "../app-types";

/** Notification source label for the live-collaboration surface. */
export const SHARE_SOURCE = "Live collaboration";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function mutateRememberedRoomV2(
  control: CollabControlV2Client,
  endpoint: "project-rename" | "close-begin",
  body: Record<string, unknown> = {},
): Promise<void> {
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

/**
 * What the v2 share borrows from App.
 *
 * The seam is `loadFile`: it binds the editor to a shared Y.Text, so the
 * handful of pieces it touches (the session itself, `activeCollabVersion`,
 * `collabReady`, the controller/lease/write-queue refs and the per-path
 * mutation counter) have to be declared above it and are passed back down
 * here. Everything the share needs in order to *start, run and stop* lives in
 * this hook instead.
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
    snapshot: ProjectSnapshot,
    options?: { skipCollabLifecycle?: boolean; deferInitialBuild?: boolean },
  ) => Promise<void>) | null>;
  setBusyLabel: (label: string | null) => void;
  startProjectTransition: () => Promise<boolean>;
  cancelProjectTransition: () => void;
  refreshProject: (scope?: {
    expectedRoot: string;
    generation: number;
  }) => Promise<ProjectSnapshot>;
  loadFile: (
    path: string,
    options?: { collabController?: CollabProjectControllerV2 },
  ) => Promise<boolean>;
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
    project,
    projectRef,
    projectRootRef,
    projectOperationGenerationRef,
    activeFile,
    recentProjects,
    editorCommentAuthorId,
    activeCollabVersion,
    setActiveCollabVersion,
    collabSession,
    setCollabSession,
    collabSessionRef,
    setCollabReady,
    collabV2ControllerRef,
    collabWorkspaceLeaseRef,
    collabDiskWriteQueueRef,
    collabPathMutationGeneration,
    collabDetachRef,
    enterProjectRef,
    setBusyLabel,
    startProjectTransition,
    cancelProjectTransition,
    refreshProject,
    loadFile,
    v2WorkspaceCallbacks,
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
  // The provider re-fires "sync" on every reconnect. Guard the one-time
  // seed/materialize so a network blip does not re-materialize the whole doc
  // over local disk and yank the open tab back to the root document.
  const collabInitializedRef = useRef(false);
  const collabLeavingRef = useRef(false);
  const preCollabProjectRootRef = useRef<string | null>(null);

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
        collabInitializedRef.current = false;
        setCollabReady(false);
        collabDetachRef.current?.();
        collabDetachRef.current = null;
        if (session) session.destroy();
        collabV2ControllerRef.current = null;
        collabSessionRef.current = null;
        collabV2TreeSignatureRef.current = null;
        setCollabSession(null);
        setActiveCollabVersion(null);
        setCollabStatus("disconnected");
        setCollabStatusDetail(null);
        setCollabPeerList([]);
        setCollabFileCount(0);
      }
    }
    // Refs and setters arrive through `deps`, so the lint rule cannot see that
    // their identities are stable; listing them changes nothing at runtime.
  }, [collabDetachRef, collabSessionRef, collabV2ControllerRef, collabWorkspaceLeaseRef, setActiveCollabVersion, setCollabReady, setCollabSession]);

  const restorePreCollabProject = useCallback(async () => {
    const prior = resolvePreCollabProjectRoot(
      preCollabProjectRootRef.current,
      recentProjects.map((item) => item.path),
    );
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

  const endHostShareSession = useCallback(async (noticeText: string) => {
    if (collabLeavingRef.current) return;
    collabLeavingRef.current = true;
    const controller = activeCollabVersion === 2 && collabRoleRef.current === "host"
      ? collabV2ControllerRef.current
      : null;
    const expectedRoot = projectRef.current?.root;
    const projectGeneration = projectOperationGenerationRef.current;
    // Closing the drawer and changing the visible state must not wait for a
    // network round trip. Start the remote close now, then finish flushing and
    // teardown in the background.
    const remoteClose = controller?.close().then(() => true, () => false) ?? Promise.resolve(true);
    setCollabOpen(false);
    setCollabStatus("disconnected");
    setCollabStatusDetail(null);
    setCollabPeerList([]);
    setNotice(noticeText);
    try {
      await controller?.flush().catch(() => undefined);
      await clearCollabLocalState({ flush: false }).catch(() => undefined);
      if (!await remoteClose) setNotice("Stopped sharing locally; the remote share may still be available", SHARE_SOURCE);
      // Peers edited these files during the session; re-read from disk so the
      // navigator, papers and citations reflect what is actually there now.
      try {
        if (expectedRoot) await refreshProject({ expectedRoot, generation: projectGeneration });
      } catch {
        // A refresh failure must not block ending the share.
      }
    } finally {
      collabLeavingRef.current = false;
    }
  }, [activeCollabVersion, clearCollabLocalState, collabV2ControllerRef, projectOperationGenerationRef, projectRef, refreshProject]);

  const leaveGuestShareSession = useCallback(async (noticeText: string, restorePrior: boolean) => {
    if (collabLeavingRef.current) return;
    collabLeavingRef.current = true;
    try {
      await clearCollabLocalState();
      setCollabOpen(false);
      if (restorePrior) {
        setNotice(noticeText);
        await restorePreCollabProject();
      } else {
        preCollabProjectRootRef.current = null;
        clearPreCollabProjectRoot();
        setNotice(noticeText);
      }
    } finally {
      collabLeavingRef.current = false;
    }
  }, [clearCollabLocalState, restorePreCollabProject]);


  /** Dialog button: host stops for everyone; guest leaves without affecting the host. */
  /**
   * Open the joined project's first document and make sure the share is
   * actually bound to it.
   *
   * `loadFile` activates the shared document only if its load is still the
   * newest one when the file's room finishes syncing — a guard that exists so a
   * slow open cannot steal the editor back from whatever the user asked for
   * next. Joining runs that load behind materialization, a project switch, and
   * a refresh, so the generation it captured is easy to lose; when it does, the
   * guest ends up connected to the room with no active document at all: no
   * announced identity, no caret for anyone to follow, and a null presence path
   * that made every collaborator read as "not in a file right now". Nothing
   * retried it, because from `loadFile`'s point of view being superseded is
   * normal. One retry re-captures the generations after everything has settled.
   */
  const bindJoinedDocument = useCallback(async (controller: CollabProjectControllerV2, path: string) => {
    const opened = await loadFile(path, { collabController: controller });
    if (opened && controller.activePath === path) return;
    if (collabV2ControllerRef.current !== controller) return;
    await loadFile(path, { collabController: controller });
  }, [collabV2ControllerRef, loadFile]);

  /**
   * The session ended from the other side: the host removed this collaborator,
   * or ended the room for everyone. Both revoke the credential, so nothing
   * about the share works afterwards — but nothing was listening for it, and
   * the removed person was left sitting in a workspace that had quietly stopped
   * syncing with no idea why. Say what happened, hand them back their own
   * project, and retire a room they can no longer enter.
   */
  const handleV2PermanentError = useCallback((error: Error) => {
    // File-scoped codes (a deleted file, a stale epoch) are recovered per file
    // and must not tear the session down.
    const code = error instanceof TextClientPermanentErrorV2 ? error.code : null;
    if (code !== "revoked" && code !== "project_closed") return;
    if (collabRoleRef.current === "host") return;
    const controller = collabV2ControllerRef.current;
    // Every open file has its own socket and they are all fenced together.
    // The first signal tears the session down; ignore later file signals once
    // that controller is no longer active so they cannot restore the project
    // and announce the same closure repeatedly.
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
   * The host steps out without ending the room: collaborators keep editing, the
   * entry stays under Your shared rooms, and rejoining — or Close for everyone —
   * is still available there. Shared by the Leave share button and by switching
   * projects, which is the same decision made a different way.
   */
  const leaveHostShareSession = useCallback(async () => {
    await clearCollabLocalState();
    setCollabOpen(false);
    refreshRecentRooms();
    setNotice("Left the share — it keeps running; rejoin it from Live collaboration", SHARE_SOURCE);
  }, [clearCollabLocalState, refreshRecentRooms]);

  const disconnectCollab = useCallback(() => {
    if (collabRoleRef.current === "host") {
      void endHostShareSession("Stopped sharing");
      return;
    }
    void leaveGuestShareSession("Left the shared session", true);
  }, [endHostShareSession, leaveGuestShareSession]);

  const settleCollabBeforeProjectSwitch = useCallback(async (nextRoot: string) => {
    const session = collabSessionRef.current;
    if (!session) return;
    const currentRoot = projectRootRef.current;
    if (currentRoot && currentRoot === nextRoot) return;
    if (collabRoleRef.current === "host") {
      // Switching projects only detaches the host locally — like closing the
      // app — instead of ending the room for everyone. The others keep editing,
      // the room stays in the recent-shares list, and the host can rejoin it.
      // Only "Stop sharing" ends the session for all.
      await leaveHostShareSession();
      return;
    }
    // Guest opened a different project: leave quietly; host keeps sharing.
    await leaveGuestShareSession("Left the shared session", false);
  }, [collabSessionRef, leaveGuestShareSession, leaveHostShareSession, projectRootRef]);


  const mapV2Status = useCallback((status: CollabProjectStatusV2) => {
    // Start sharing owns the more useful phase-by-phase progress copy. Provider
    // status changes during openPath must not erase it or expose the live card
    // before setup has actually finished.
    if (collabStartingRef.current) return;
    const mapped = mapCollabProjectStatusV2(status);
    setCollabStatus(mapped.status);
    setCollabStatusDetail(mapped.detail);
  }, []);

  /**
   * v2 catalog push (peer create/rename/delete, grants, lifecycle): keep the
   * file count live and schedule a general tree refresh when paths change.
   * Catalog notification precedes disk reconciliation, so remote deletion has
   * a separate post-delete refresh that also fences stale editor buffers.
   * The first callback after join only records the baseline; materialization
   * refreshes the tree itself.
   */
  const handleV2Catalog = useCallback((catalog: CatalogV2) => {
    // A closed room is gone for good: the coordinator revokes every grant with
    // it, so nobody can rejoin and the entry is only there to be clicked and
    // fail. Drop it the moment the catalog says so, on whichever side sees it.
    if (catalog.lifecycle === "closing" || catalog.lifecycle === "closed") {
      const activeController = collabV2ControllerRef.current;
      const deployment = activeController?.host;
      if (deployment) {
        forgetCollabProjectV2(deployment, catalog.projectInstanceId);
        refreshRecentRooms();
      }
      // The WebSocket close is the immediate path; the catalog poll is the
      // fallback for a guest who happened to be offline when the host closed
      // the room. Either signal must leave the dead shared workspace instead
      // of only removing its recent-room entry.
      if (collabRoleRef.current !== "host" && activeController?.room === catalog.projectInstanceId) {
        void leaveGuestShareSession(
          t`The host ended this share. Your own project is open again.`,
          true,
        );
        return;
      }
    }
    const livePaths = catalog.files.filter((file) => file.state === "live").map((file) => file.path).sort();
    setCollabFileCount(livePaths.length);
    const signature = livePaths.join("\n");
    if (collabV2TreeSignatureRef.current === null) {
      collabV2TreeSignatureRef.current = signature;
      return;
    }
    if (collabV2TreeSignatureRef.current !== signature) {
      collabV2TreeSignatureRef.current = signature;
      void refreshProject().catch(() => undefined);
    }
  }, [collabV2ControllerRef, leaveGuestShareSession, refreshProject, refreshRecentRooms, t]);

  /**
   * Push a non-active text buffer into the v2 session and onto disk. Sideload:
   * publishing must not steal the session's active file (editor binding,
   * awareness path) from whatever the user is editing. Returns false when the
   * file is not live in the share (no session, or a path outside the catalog),
   * so the caller can fall back to a plain local write.
   *
   * Every caller must list this in its own dependency array — `activeCollabVersion`
   * is the single value below that is state rather than a ref, so this callback's
   * identity tracks it exactly, and a closure captured while it was still `null`
   * answers `false` forever. A caller memoized only on `collabSession` can capture
   * such a closure: `loadFile` publishes `setCollabSession` from a branch that also
   * accepts `collabSessionRef.current`/an explicit controller, so the session can
   * reach state one commit *before* `activeCollabVersion` does, and nothing after
   * that re-runs the caller's memo. The result is a share where that call site
   * silently stops reaching collaborators for the rest of the session. The churn is
   * negligible in exchange: `activeCollabVersion` flips twice per share.
   *
   * `expectedMutationGeneration` is a different guard and no substitute — it is a
   * default parameter over a `useCallback([])` reader of a ref, so it is always
   * evaluated fresh at call time even from a stale closure. It fences the disk
   * write against a rename/delete landing during `openPath`, not against staleness.
   */
  const publishTextToCollabV2 = useCallback(async (path: string, content: string, expectedMutationGeneration = collabPathMutationGeneration(path)): Promise<boolean> => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !controller || path.toLocaleLowerCase().endsWith(".tldr") || isSpreadsheetPath(path)) return false;
    if (!controller.hasTextPath(path)) return false;
    const ytext = await controller.openPath(path, "secondary", { sideload: true });
    // Minimal-span merge, not delete-all + insert-all: a peer's concurrent
    // edits outside the changed span survive, and the local origin keeps disk
    // observers from rewriting the file we are about to write ourselves.
    mergeTextIntoYText(ytext, content);
    const lease = collabWorkspaceLeaseRef.current;
    const projectRoot = lease?.projectRoot ?? projectRootRef.current;
    if (!projectRoot) throw new Error("The project closed before the file could be written.");
    if (expectedMutationGeneration !== collabPathMutationGeneration(path)) return true;
    if (lease) {
      await collabDiskWriteQueueRef.current.run(lease, path, () => expectedMutationGeneration === collabPathMutationGeneration(path)
        ? invoke("write_project_file", { path, content: ytext.toString(), projectRoot })
        : Promise.resolve());
    } else {
      await invoke("write_project_file", { path, content: ytext.toString(), projectRoot });
    }
    return true;
  }, [activeCollabVersion, collabDiskWriteQueueRef, collabPathMutationGeneration, collabV2ControllerRef, collabWorkspaceLeaseRef, projectRootRef]);

  /**
   * Register a locally created file with the live v2 share so collaborators
   * receive it: catalog create (the host then marks it live), then content —
   * a text seed for text/board files, a binary upload for figures. No-ops
   * outside a share; on failure the file stays local-only (the pre-existing
   * behavior) and the user gets a warning naming the file.
   */
  const shareCreatedFileWithCollabV2 = useCallback(async (path: string, kind: "text" | "binary" | "board" | "spreadsheet") => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !controller) return;
    try {
      if (kind === "binary") {
        const asset = await invoke<AssetPreview>("read_project_asset", { path });
        const bytes = Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0));
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
    if (collabStartingRef.current) return;
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
    void (async () => {
        let controller: CollabProjectControllerV2 | null = null;
        const assertCurrentStart = () => {
          if (collabStartGenerationRef.current !== startGeneration) throw new Error("Share start was canceled");
        };
        setCollabStatus("connecting");
        setCollabStatusDetail(t`Scanning project files…`);
        try {
          const resolved = resolveCollabHost(collabHost);
          saveCollabHost(resolved);
          saveCollabDisplayName(collabName.trim());
          const deployment = collabDeploymentOrigin(resolved);
          const nativeInventory = await invoke<{ files: Array<{ path: string; contentKind: "text" | "binary"; size: number }>; excluded: Array<{ pathOrPattern: string; reason: string }> }>("collab_project_inventory_v2");
          assertCurrentStart();
          if (nativeInventory.excluded.length) {
            const details = nativeInventory.excluded.map(item => `• ${item.pathOrPattern} — ${item.reason}`).join("\n");
            if (!await confirmAction(`Some project items won't be included in this share:\n\n${details}\n\nContinue with the listed regular files?`)) {
              setCollabStatus("disconnected");
              setCollabStatusDetail(null);
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
                const asset = await invoke<AssetPreview>("read_project_asset", { path });
                return Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0));
              },
            },
            onPrepareProgress: (completed, total) => { if (collabStartGenerationRef.current === startGeneration) setCollabStatusDetail(t`Preparing project files… ${completed}/${total}`); },
            onProgress: (completed, total) => { if (collabStartGenerationRef.current === startGeneration) setCollabStatusDetail(t`Uploading project files… ${completed}/${total}`); },
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
          const path = controller.hasTextPath(activeFile || "") ? activeFile : controller.catalogTextPaths()[0];
          if (!path) throw new Error("The shared project has no text files");
          setCollabStatusDetail(t`Opening the shared document…`);
          await controller.openPath(path);
          assertCurrentStart();
          setCollabStatusDetail(t`Creating an invite…`);
          const invitation = await controller.createInvitation("write");
          assertCurrentStart();
          collabV2InvitationRef.current = invitation;
          const workspaceGeneration = collabWorkspaceGenerationRef.current + 1;
          collabWorkspaceGenerationRef.current = workspaceGeneration;
          collabWorkspaceLeaseRef.current = {
            projectRoot: project.root,
            generation: workspaceGeneration,
            isCurrent: () => collabWorkspaceGenerationRef.current === workspaceGeneration && projectRootRef.current === project.root,
          };
          controller.bindWorkspace(collabWorkspaceLeaseRef.current, v2WorkspaceCallbacks(collabWorkspaceLeaseRef.current));
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
          const canceled = collabStartGenerationRef.current !== startGeneration;
          if (controller) {
            if (collabV2ControllerRef.current === controller) await clearCollabLocalState().catch(() => undefined);
            else controller.destroy();
          }
          if (canceled) {
            if (!collabStartingRef.current && collabSessionRef.current === null) {
              setCollabStatus("disconnected");
              setCollabStatusDetail(null);
            }
            return;
          }
          setCollabStatus("error");
          setCollabStatusDetail(t`Import failed — retry Start sharing`);
          setError(toMessage(reason));
        } finally {
          if (collabStartGenerationRef.current === startGeneration) collabStartingRef.current = false;
        }
      })();
  }, [handleV2PermanentError, activeFile, clearCollabLocalState, collabHost, collabName, collabProjectName, collabSessionRef, collabV2ControllerRef, collabWorkspaceLeaseRef, editorCommentAuthorId, handleV2Catalog, loadFile, mapV2Status, project, projectRootRef, setActiveCollabVersion, setCollabReady, setCollabSession, t, v2WorkspaceCallbacks]);

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
    void (async () => {
      // Host rows deliberately have no local-only removal: discarding the host
      // credential would leave a live room that this device can no longer end.
      if (record.permission === "host") return;
      if (record.credentialRef) {
        try {
          await collabCredentialStore().delete(record.credentialRef, record.projectInstanceId, record.host);
        } catch (reason) {
          setError(toMessage(reason));
          return;
        }
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
        const store = collabCredentialStore();
        const credential = await readRememberedV2Credential(record, store);
        const control = new CollabControlV2Client(record.host, record.projectInstanceId, credential);
        await mutateRememberedRoomV2(control, "project-rename", { name: next });
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
        if (
          activeCollabVersion === 2
          && collabRoleRef.current === "host"
          && activeController?.room === record.projectInstanceId
        ) {
          await activeController.flush();
          await activeController.close();
          remoteClosed = true;
          await clearCollabLocalState({ flush: false });
          setCollabOpen(false);
          setCollabStatus("disconnected");
        } else {
          const credential = await readRememberedV2Credential(record, store);
          const control = new CollabControlV2Client(record.host, record.projectInstanceId, credential);
          await mutateRememberedRoomV2(control, "close-begin");
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
        if (!remoteClosed) {
          setError(`Could not close the room: ${detail}`);
          return;
        }
        setError(remoteClosed
          ? `The room was closed, but local cleanup did not finish: ${detail}. Keep this entry and retry Close to finish cleanup.`
          : `Could not close the room: ${detail}`);
      }
    })();
  }, [activeCollabVersion, clearCollabLocalState, collabV2ControllerRef, refreshRecentRooms]);

  return {
    collabOpen,
    setCollabOpen,
    collabMode,
    setCollabMode,
    collabHost,
    collabRoom,
    setCollabRoom,
    collabInvite,
    setCollabInvite,
    collabName,
    setCollabName,
    collabProjectName,
    setCollabProjectName,
    recentProjectsV2,
    refreshRecentRooms,
    collabStatus,
    setCollabStatus,
    collabStatusDetail,
    collabPeerList,
    setCollabPeerList,
    collabPeers,
    collabFileCount,
    setCollabFileCount,
    collabRole,
    setCollabRole,
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
