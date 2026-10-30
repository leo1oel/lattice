import type { SetStateAction } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { OverleafLink } from "../app-types";
import { loadOverleafRemoteDelete, loadOverleafSyncMode, type OverleafRemoteDelete, type OverleafSyncMode } from "../settings/app-settings";
import type { OverleafCollabTab } from "./overleaf-collab";
import type { OverleafEvent } from "./overleaf-realtime-listen";
import type { DocEntry, EntityEntry, OverleafPermission, RealtimeStatus } from "./overleaf-realtime-model";

/** The project's Overleaf link, and whether the signed-in session may use it. */
export type OverleafLinkFor = { root: string; link: OverleafLink; active: boolean };

/** One window's Overleaf connection, as plain data. */
export type OverleafConnectionState = {
  // ---- The bridge (useOverleafWorkspace).
  /**
   * The link counts only while the root it was fetched for is still open (for
   * one render of a switch it is the old project's). Inactive links are kept,
   * so a paused one is not offered for upload as a second Overleaf project.
   */
  linkFor: OverleafLinkFor | null;
  /** A sync (or publish) owns the project. */
  syncing: boolean;
  syncMode: OverleafSyncMode;
  remoteDelete: OverleafRemoteDelete;
  /** Manual mode's badge: Overleaf has work this project has not pulled. */
  remoteChanges: boolean;
  pickerOpen: boolean;
  reviewOpen: boolean;
  collabOpen: boolean;
  collabTab: OverleafCollabTab;
  /** The file with conflict markers a sync left to resolve. */
  conflictPath: string | null;
  /**
   * What presence cannot get elsewhere: our connection id, and which file
   * each document id is (rebuilt on every tree change).
   */
  selfId: string | null;
  docPaths: Map<string, string>;

  // ---- The live channel (useOverleafRealtime).
  status: RealtimeStatus;
  detail: string | null;
  /** The open file is being edited through the channel. */
  liveFile: boolean;
  /** See `publishUnacknowledged` in useOverleafRealtime. */
  unacknowledged: boolean;
  /** The role Overleaf named, and the project it named it for; read it through `projectAccess`. */
  projectPermission: { projectRoot: string | null; permission: OverleafPermission };
  /**
   * The channel's view of the project tree: the document id of each path,
   * and every entity's id and kind for the endpoints that take one. Replaced
   * whole on each tree change, so the effect that joins the open document
   * runs again once a tree arrives.
   */
  docs: Map<string, string>;
  entities: Map<string, { id: string; kind: string }>;
  /** The paths the channel owns, sorted, which ordinary syncing must leave alone. */
  livePaths: string[];
};

type Setters = {
  [K in keyof OverleafConnectionState as `set${Capitalize<K>}`]: (next: SetStateAction<OverleafConnectionState[K]>) => void
};

type OverleafConnectionActions = Setters & {
  /** Replace the channel's tree with a connect result's or a tree event's. */
  showDocumentTree: (entries: DocEntry[], entityEntries?: EntityEntry[]) => void;
  /** Publish the paths the channel owns; an unchanged set keeps its array. */
  publishLivePaths: (paths: string[]) => void;
  /** Follow the live channel's identity and tree for presence. */
  noteChannelEvent: (event: OverleafEvent) => void;
  /** No linked project: presence has no connection and no tree. */
  forgetChannel: () => void;
};

/**
 * This account's role in `projectRoot`, and whether it may change documents
 * directly — false for a reviewer, who can only suggest. A permission is only
 * meaningful for the project whose connect result supplied it: during a root
 * switch, the previous project's role must not be reused for the new one.
 * Unknown fails closed: until Overleaf names a role, neither the live channel
 * nor the durable ZIP synchronizer may assume write access.
 */
export function projectAccess(scoped: OverleafConnectionState["projectPermission"], projectRoot: string | null) {
  const permission = scoped.projectRoot === projectRoot ? scoped.permission : "unknown";
  return { permission, canWrite: permission === "owner" || permission === "readAndWrite" };
}

/** The fields the bridge renders from, picked whole so a write elsewhere re-renders nothing. */
export const bridgeFields = ({
  linkFor, syncing, syncMode, remoteDelete, remoteChanges, pickerOpen, reviewOpen, collabOpen, collabTab, conflictPath, selfId, docPaths,
}: OverleafConnectionState) => ({
  linkFor, syncing, syncMode, remoteDelete, remoteChanges, pickerOpen, reviewOpen, collabOpen, collabTab, conflictPath, selfId, docPaths,
});

/** The live channel's rendered fields; the tree is useOverleafDocumentTree's. */
export const channelFields = ({ status, detail, liveFile, unacknowledged, projectPermission }: OverleafConnectionState) => (
  { status, detail, liveFile, unacknowledged, projectPermission }
);

export type OverleafConnectionStore = StoreApi<OverleafConnectionState & OverleafConnectionActions>;

const initialState = (): OverleafConnectionState => ({
  linkFor: null, syncing: false, syncMode: loadOverleafSyncMode(), remoteDelete: loadOverleafRemoteDelete(),
  remoteChanges: false, pickerOpen: false, reviewOpen: false, collabOpen: false, collabTab: "comments",
  conflictPath: null, selfId: null, docPaths: new Map(),
  status: "off", detail: null, liveFile: false, unacknowledged: false,
  projectPermission: { projectRoot: null, permission: "unknown" },
  docs: new Map(), entities: new Map(), livePaths: [],
});

/**
 * One window's Overleaf connection: the link and sync state the bridge keeps,
 * the panels it opens, and the realtime channel's status and project tree.
 * Writes land at once, so async work reads the latest with `getState()`;
 * components subscribe to the slices they render. The work that decides what
 * to write lives in useOverleafWorkspace and useOverleafRealtime.
 */
export function createOverleafConnectionStore(): OverleafConnectionStore {
  return createStore<OverleafConnectionState & OverleafConnectionActions>()((set) => {
    // A React-style setter per field, updater functions included (no field holds a function).
    const setters = Object.fromEntries(Object.keys(initialState()).map((key) => [
      `set${key[0].toUpperCase()}${key.slice(1)}`,
      (next: unknown) => set((state) => ({
        [key]: typeof next === "function" ? next(state[key as keyof OverleafConnectionState]) : next,
      })),
    ])) as Setters;
    return {
      ...initialState(),
      ...setters,
      showDocumentTree: (entries, entityEntries = []) => set({
        docs: new Map(entries.map((doc) => [doc.path, doc.id])),
        entities: new Map(entityEntries.map((entity) => [entity.path, { id: entity.id, kind: entity.kind }])),
      }),
      publishLivePaths: (paths) => set(({ livePaths }) => (
        livePaths.length === paths.length && livePaths.every((path, index) => path === paths[index]) ? {} : { livePaths: paths }
      )),
      noteChannelEvent: (event) => {
        if (event.type === "connected" && event.publicId) set({ selfId: event.publicId });
        else if (event.type === "projectJoined" || event.type === "treeChanged") {
          set({ docPaths: new Map(event.docs.map((doc) => [doc.id, doc.path])) });
        } else if (event.type === "disconnected") set({ selfId: null });
      },
      forgetChannel: () => set({ selfId: null, docPaths: new Map() }),
    };
  });
}
