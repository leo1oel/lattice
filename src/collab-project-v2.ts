import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { CatalogFileV2, CatalogV2, ProjectLifecycle } from "../protocol/collab-v2";
import { CollabControlErrorV2, CollabControlV2Client, type PresenceEntryV2 } from "./collab-control-v2";
import type { CollabCredentialStore } from "./collab-credentials";
import { CollabTextDurableStoreV2, type TextNamespaceV2 } from "./collab-text-v2-store";
import { CollabTextClientV2, CollabTextProviderPoolV2, createYPartyTransportV2, type ReconnectPolicyV2, type TextDurabilityStateV2, type TextTransportFactoryV2 } from "./collab-text-v2";
import type { CollabDiagnosticSinkV2 } from "./collab-diagnostics-v2";
import { CollabBinaryV2Client, type BinaryReplaceResult } from "./collab-binary-v2";
import { formatCollabInvitationV2 } from "./collab-invitation-v2";
import { peerColorForKey, readCollabPeers, type CollabPeer } from "./collab-session";
import type { OperationResultV2 } from "../protocol/collab-v2";
import { putTextFileV2 } from "./collab-import-v2";

export type CollabProjectStatusV2 = "syncing" | "server-received" | "durable" | "offline" | "read-only" | "importing" | "closed" | "error";
export type CollabProjectV2Options = {
  deployment: string; projectInstanceId: string; credentialRef: string; credentialStore: CollabCredentialStore;
  store?: CollabTextDurableStoreV2; transportFactory?: TextTransportFactoryV2; poolCapacity?: number;
  /** How often the controller polls the coordinator's event stream for peer catalog changes. */
  eventsPollIntervalMs?: number;
  /** Shown to collaborators in presence and cursor labels. */
  displayName?: string;
  /**
   * Our actor's permission. "read" blocks local creates; "host" additionally
   * takes on the catalog duty of marking peer-created (initializing) files
   * live, which the server only allows the host to do.
   */
  permission?: "host" | "write" | "read";
  onStatus?: (status: CollabProjectStatusV2) => void; onCatalog?: (catalog: CatalogV2) => void;
  /** Live peer list: same-file awareness merged with cross-file coordinator presence. */
  onPeers?: (peers: CollabPeer[]) => void;
  onPermanentError?: (error: Error, fileId?: string) => void; diagnostics?: CollabDiagnosticSinkV2; now?: () => number;
  /** Test/tuning hook: overrides the reconnect backoff for pooled text clients. */
  reconnectPolicy?: ReconnectPolicyV2;
};
export type CollabMaterializeLeaseV2 = { projectRoot: string; isCurrent(): boolean };
export type CollabMaterializeCallbacksV2 = {
  writeText(path: string, content: string, projectRoot: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array, projectRoot: string): Promise<void>;
  /** Optional local delete/rename so peer tree changes can be reconciled onto disk. */
  delete?(path: string, projectRoot: string): Promise<void>;
  rename?(oldPath: string, newPath: string, projectRoot: string): Promise<string | void>;
  concurrency?: number;
};
export type CollabLocalMutationsV2 = {
  rename(oldPath: string, newPath: string, projectRoot: string): Promise<string | void>;
  delete(path: string, projectRoot: string): Promise<void>;
  writeBinaryConflict?(path: string, bytes: Uint8Array, projectRoot: string): Promise<void>;
};
export type CollabMaterializeResultV2 = { rootPath: string; openPath: string; textCount: number; binaryCount: number; fileCount: number };

/** Tree-level difference between two catalog snapshots, as seen by a peer. */
export type CatalogDeltaV2 = {
  /** Files live now that were not live before (including epoch-bumped text files, which need a full rewrite). */
  created: CatalogFileV2[];
  /** Files live in both snapshots whose path changed (same document epoch). */
  renamed: { file: CatalogFileV2; previousPath: string }[];
  /** Previously live files that are gone or no longer live (tombstoned/purging/deleting). */
  deleted: { fileId: string; path: string }[];
  /** Live binaries whose content moved (hash/contentRevision changed) and must be re-downloaded. */
  staleBinaries: CatalogFileV2[];
};

const LIVE_STATES = new Set(["live"]);
const BOARD_DISK_WRITE_DEBOUNCE_MS = 250;
const TEXT_DISK_WRITE_DEBOUNCE_MS = 100;

function scheduleProjectFrameV2(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

function liveById(catalog: CatalogV2): Map<string, CatalogFileV2> {
  const map = new Map<string, CatalogFileV2>();
  for (const file of catalog.files) if (LIVE_STATES.has(file.state)) map.set(file.fileId, file);
  return map;
}

/**
 * Stable synthetic id for a peer known only through coordinator presence. Used
 * purely as a UI key; collisions with live awareness ids only shuffle order.
 */
function presenceClientId(instanceId: string): number {
  let hash = 0;
  for (let index = 0; index < instanceId.length; index++) hash = (hash * 31 + instanceId.charCodeAt(index)) | 0;
  return hash;
}

/**
 * Diff two catalog snapshots into actionable tree changes. An epoch change is
 * treated as create-at-current-path (the new doc must be re-pulled in full),
 * plus a delete of the previous path when it differs.
 */
export function planCatalogDeltaV2(previous: CatalogV2, next: CatalogV2): CatalogDeltaV2 {
  const before = liveById(previous);
  const after = liveById(next);
  const delta: CatalogDeltaV2 = { created: [], renamed: [], deleted: [], staleBinaries: [] };
  for (const [fileId, file] of after) {
    const prior = before.get(fileId);
    if (!prior || prior.documentEpoch !== file.documentEpoch) {
      delta.created.push(file);
      if (prior && prior.path !== file.path) delta.deleted.push({ fileId, path: prior.path });
      continue;
    }
    if (prior.path !== file.path) delta.renamed.push({ file, previousPath: prior.path });
    if (file.kind === "binary" && (prior.hash !== file.hash || prior.contentRevision !== file.contentRevision)) delta.staleBinaries.push(file);
  }
  for (const [fileId, prior] of before) {
    if (!after.has(fileId)) delta.deleted.push({ fileId, path: prior.path });
  }
  return delta;
}

/** One v2 project session. The catalog owns paths; each immutable file identity owns its own Y.Doc. */
export class CollabProjectControllerV2 {
  readonly version = 2 as const;
  readonly room: string;
  readonly host: string;
  readonly token = "";
  private control!: CollabControlV2Client;
  private catalogValue!: CatalogV2;
  private readonly clients = new Map<string, CollabTextClientV2>();
  private readonly openingClients = new Map<string, Promise<CollabTextClientV2>>();
  private readonly diskObservers = new Map<string, () => void>();
  private readonly diskObserverFlushes = new Map<string, () => Promise<void>>();
  private readonly canWriteListeners = new Set<(canWrite: boolean) => void>();
  private readonly fileMutations = new Map<string, Promise<void>>();
  private readonly pendingDiskWrites = new Set<Promise<void>>();
  private readonly pool: CollabTextProviderPoolV2;
  private readonly fallbackDoc = new Y.Doc();
  private fallbackAwareness = new Awareness(this.fallbackDoc);
  private activeClient?: CollabTextClientV2;
  private activePin: "main" | "secondary" = "main";
  private destroyed = false;
  private cancelPeerRefresh?: () => void;
  private firstFileOpened = false;
  private statusValue: CollabProjectStatusV2 = "syncing";
  private credential = "";
  private materializeLease?: CollabMaterializeLeaseV2;
  private materializeContext?: { lease: CollabMaterializeLeaseV2; callbacks: CollabMaterializeCallbacksV2 };
  private binaryClient?: CollabBinaryV2Client;
  private eventsTimer?: ReturnType<typeof setInterval>;
  private eventsPolling = false;
  private presenceQueue: Promise<void> = Promise.resolve();
  private presenceLeaveRequested = false;
  /** Stable per-session identity announced in awareness and coordinator presence. */
  private readonly instanceId = crypto.randomUUID();
  private presenceValue: Record<string, PresenceEntryV2> = {};
  private awarenessListener?: () => void;
  /** Peer reconcile must not undo tree operations this client initiated itself. */
  private readonly locallyDeleted = new Set<string>();
  private readonly locallyRenamed = new Map<string, string>();
  /**
   * Files this client created mid-share. Skipped in the reconcile's created
   * pass: our disk copy is the seed source, so pulling the (possibly still
   * empty) server content over it would clobber the seed.
   */
  private readonly locallyCreated = new Set<string>();
  activePath = "";
  ytext: Y.Text = this.fallbackDoc.getText("content");
  undoManager = new Y.UndoManager(this.ytext);
  provider: { awareness: Awareness } = { awareness: this.fallbackAwareness };
  /**
   * Bumped every time `provider.awareness` is swapped (file switch or transport
   * reconnect). React effect/memo deps downstream watch this so yCollab carets
   * and board presence re-bind to the live Awareness instead of a dead one.
   */
  awarenessVersion = 0;

  get canWrite(): boolean {
    return (this.options.permission ?? "write") !== "read" && !this.activeClient?.isStopped;
  }

  subscribeCanWrite = (listener: (canWrite: boolean) => void): (() => void) => {
    this.canWriteListeners.add(listener);
    listener(this.canWrite);
    return () => this.canWriteListeners.delete(listener);
  };

  private emitCanWrite(): void {
    const value = this.canWrite;
    for (const listener of this.canWriteListeners) listener(value);
  }

  /** Reconnects replace a client's transport and Awareness; follow the swap. */
  private onTransportReplaced(client: CollabTextClientV2): void {
    if (this.destroyed || client.isDestroyed || client !== this.activeClient) return;
    const awareness = client.awareness ?? this.fallbackAwareness;
    if (this.provider.awareness === awareness) return;
    this.provider = { awareness };
    this.awarenessVersion += 1;
    // Re-announce identity/path and rebind the peers listener on the new
    // Awareness — the old object no longer reaches the network.
    this.announcePresence(undefined, client, this.activePath);
  }

  private constructor(private readonly options: CollabProjectV2Options, private readonly startedAt: number) {
    this.room = options.projectInstanceId; this.host = options.deployment;
    this.pool = new CollabTextProviderPoolV2(options.poolCapacity ?? 8, options.now);
  }

  static async start(options: CollabProjectV2Options): Promise<CollabProjectControllerV2> {
    const now = options.now ?? Date.now; const controller = new CollabProjectControllerV2(options, now());
    const credential = await options.credentialStore.get(options.credentialRef, options.projectInstanceId, options.deployment);
    if (!credential) throw new Error("Collaboration credential is unavailable");
    controller.control = new CollabControlV2Client(options.deployment, options.projectInstanceId, credential);
    controller.credential = credential;
    try { await controller.refetchCatalog(); options.diagnostics?.({ name: "join_latency", at: now(), durationMs: now() - controller.startedAt }); }
    catch (error) { controller.setStatus("offline"); throw error; }
    controller.startEventsPolling(options.eventsPollIntervalMs ?? 3_000);
    return controller;
  }

  get doc(): Y.Doc { return this.activeClient?.doc ?? this.fallbackDoc; }
  get status(): CollabProjectStatusV2 { return this.statusValue; }
  get lifecycle(): ProjectLifecycle { return this.catalogValue.lifecycle; }
  get peers(): number { return Math.max(0, this.provider.awareness.getStates().size - 1); }
  fileCount(): number { return this.catalogValue.files.filter((file) => file.state === "live").length; }
  catalogFiles(): CatalogFileV2[] { return this.catalogValue.files.map((file) => ({ ...file })); }
  catalogTextPaths(): string[] { return this.catalogValue.files.filter((file) => file.state === "live" && file.kind !== "binary").map((file) => file.path); }
  hasTextPath(path: string): boolean { return this.catalogTextPaths().includes(path); }
  setAwarenessPath(path: string): void { const state = this.provider.awareness.getLocalState() ?? {}; this.provider.awareness.setLocalState({ ...state, path }); }

  async refetchCatalog(): Promise<CatalogV2> {
    this.assertLiveController();
    const catalog = await this.control.catalog();
    this.assertLiveController();
    if (catalog.projectInstanceId !== this.options.projectInstanceId) throw new Error("Catalog project identity mismatch");
    this.catalogValue = catalog;
    this.reconcileDiskObservers();
    this.options.onCatalog?.(catalog);
    this.setStatus(catalog.lifecycle === "importing" ? "importing" : catalog.lifecycle === "closed" ? "closed" : "syncing");
    // Binary files have no text snapshot to import, so the host can publish
    // them directly. Text/board creators publish through the durable import
    // endpoint instead; marking those live here could expose an empty room.
    if (catalog.lifecycle === "live" && this.options.permission === "host"
      && catalog.files.some((file) => file.state === "initializing" && file.kind === "binary")) {
      void this.finalizeInitializingFiles().catch(() => undefined);
    }
    return catalog;
  }

  /** Mark initializing binary files live, sequentially so revisions stay chained. */
  private finalizingInitializing = false;
  private async finalizeInitializingFiles(): Promise<void> {
    // The sweep fires on every refetch; overlap would double file-ready the
    // same file (the second call 400s as "not initializing").
    if (this.finalizingInitializing) return;
    this.finalizingInitializing = true;
    try {
      for (const file of this.catalogValue.files.filter((entry) => entry.state === "initializing" && entry.kind === "binary")) {
        await this.fileReady(file.fileId).catch((error) => {
          this.options.onPermanentError?.(error instanceof Error ? error : new Error(String(error)), file.fileId);
        });
      }
    } finally {
      this.finalizingInitializing = false;
    }
  }

  /** Host-only catalog op: flip an initializing file to live. */
  private async fileReady(fileId: string): Promise<void> {
    const result = await this.control.operation<OperationResultV2>("file-ready", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, fileId });
    this.assertLiveController();
    this.catalogValue.catalogRevision = result.catalogRevision;
    const entry = this.fileById(fileId);
    if (entry && entry.state === "initializing") entry.state = "live";
  }
  /**
   * Pull the coordinator's event stream; on any catalog movement refetch and
   * reconcile the local workspace tree (peer creates/renames/deletes/binary
   * replacements) onto disk. Called by the events poller started in `start()`.
   */
  async fetchEvents(): Promise<void> {
    const previous = this.catalogValue;
    try {
      const events = await this.control.events(previous.catalogRevision);
      if (!events.refetch && events.events.length === 0 && events.catalogRevision === previous.catalogRevision) return;
    } catch (error) {
      // The coordinator's event buffer (MAX_EVENTS) has scrolled past our
      // cursor — e.g. after a long sleep or a bulk import. Without this branch
      // every poll keeps requesting the same stale cursor and the client never
      // converges again. Fall back to a full catalog pull.
      if (!(error instanceof CollabControlErrorV2 && error.requiresRefetch)) throw error;
    }
    await this.refetchCatalog();
    await this.reconcileCatalogDelta(previous);
  }

  private startEventsPolling(intervalMs: number): void {
    if (this.eventsTimer !== undefined) return;
    this.eventsTimer = setInterval(() => { void this.pollEvents(); }, intervalMs);
  }

  private async pollEvents(): Promise<void> {
    if (this.destroyed || this.eventsPolling) return;
    if (this.catalogValue?.lifecycle === "closed") { this.stopEventsPolling(); return; }
    this.eventsPolling = true;
    try { await this.heartbeatPresence(); await this.fetchEvents(); }
    catch { this.options.diagnostics?.({ name: "events_poll_error", at: (this.options.now ?? Date.now)() }); }
    finally { this.eventsPolling = false; }
  }

  private stopEventsPolling(): void {
    if (this.eventsTimer === undefined) return;
    clearInterval(this.eventsTimer);
    this.eventsTimer = undefined;
  }

  /**
   * Apply the tree-level delta between an earlier catalog snapshot and the
   * current one to the materialized workspace. Text *content* never needs
   * this — Yjs sync plus the disk observers cover it — but structure changes
   * (create/rename/delete, binary replacement) only exist server-side until a
   * peer pulls them down. Operations this client initiated are skipped: they
   * already mutated the local tree (and `catalogValue`) inline.
   */
  private async reconcileCatalogDelta(previous: CatalogV2): Promise<void> {
    const context = this.materializeContext;
    if (!context || this.destroyed) return;
    const { lease, callbacks } = context;
    const plan = planCatalogDeltaV2(previous, this.catalogValue);
    const report = (error: unknown, fileId?: string) => this.options.onPermanentError?.(error instanceof Error ? error : new Error(String(error)), fileId);

    for (const { file, previousPath } of plan.renamed) {
      if (this.locallyRenamed.get(file.fileId) === file.path) continue;
      const client = this.clients.get(file.fileId);
      if (client) this.pool.rename(client, file.path);
      if (this.activePath === previousPath) { this.activePath = file.path; this.setAwarenessPath(file.path); }
      if (callbacks.rename) await this.enqueueFile(file.fileId, async () => {
        this.checkLease(lease);
        await callbacks.rename!(previousPath, file.path, lease.projectRoot);
      }).catch((error) => report(error, file.fileId));
    }

    for (const file of plan.created) {
      if (this.locallyCreated.has(file.fileId)) continue;
      // A binary with no hash was created mid-share and its upload is still in
      // flight; the staleBinaries pass after its commit pulls the bytes.
      if (file.kind === "binary" && !file.hash) continue;
      await this.enqueueFile(file.fileId, async () => {
        this.checkLease(lease);
        if (file.kind !== "binary") {
          this.detachDiskObserver(file.fileId);
          const stale = this.clients.get(file.fileId);
          if (stale && stale.namespace.documentEpoch !== file.documentEpoch) { stale.destroy(); this.clients.delete(file.fileId); }
          // Sideload: pulling the new file must not steal the editor's active binding.
          const ytext = await this.openPath(file.path, "secondary", { allowCachedOffline: true, sideload: true });
          const client = this.clients.get(file.fileId);
          const content = file.kind === "board" && client
            ? (await import("./board-yjs-bridge")).boardDocContent(client.doc)
            : ytext.toString();
          await callbacks.writeText(file.path, content, lease.projectRoot);
          if (client) this.attachDiskObserver(file, client, lease, callbacks);
        } else {
          const bytes = await this.getBinaryClient().download(file.fileId, file.documentEpoch);
          this.checkLease(lease);
          await callbacks.writeBytes(file.path, bytes, lease.projectRoot);
        }
      }).catch((error) => report(error, file.fileId));
    }

    const refreshed = new Set(plan.created.map((file) => file.fileId));
    for (const file of plan.staleBinaries) {
      if (refreshed.has(file.fileId)) continue;
      await this.enqueueFile(file.fileId, async () => {
        this.checkLease(lease);
        const bytes = await this.getBinaryClient().download(file.fileId, file.documentEpoch);
        this.checkLease(lease);
        await callbacks.writeBytes(file.path, bytes, lease.projectRoot);
      }).catch((error) => report(error, file.fileId));
    }

    for (const { fileId, path } of plan.deleted) {
      this.detachDiskObserver(fileId);
      if (this.locallyDeleted.has(fileId)) continue;
      // An epoch bump reusing the same path shows up as delete+create; the
      // create already rewrote the content, so deleting would remove the live file.
      if (this.catalogValue.files.some((file) => file.state === "live" && file.path === path)) continue;
      if (callbacks.delete) await this.enqueueFile(fileId, async () => {
        this.checkLease(lease);
        await callbacks.delete!(path, lease.projectRoot);
      }).catch((error) => report(error, fileId));
    }
  }

  async openPath(path: string, pin: "main" | "secondary" = "main", options: { allowCachedOffline?: boolean; timeoutMs?: number; sideload?: boolean; activateIf?: () => boolean } = {}): Promise<Y.Text> {
    this.assertLiveController(); const file = this.file(path); if (!file) throw new Error(`File is not in the v2 catalog: ${path}`); if (file.state !== "live" && file.state !== "initializing") throw new Error("File is unavailable");
    let client = this.clients.get(file.fileId);
    // The provider pool evicts (destroys) unpinned clean clients without
    // notifying us; a destroyed client must be resurrected rather than reused,
    // otherwise connect() throws "Client is destroyed" forever.
    if (client?.isDestroyed) { this.detachDiskObserver(file.fileId); this.clients.delete(file.fileId); client = undefined; }
    if (client && client.namespace.documentEpoch !== file.documentEpoch) { client.destroy(); this.clients.delete(file.fileId); this.options.onPermanentError?.(new Error("File epoch changed; export cached recovery before reopening"), file.fileId); throw new Error("File epoch mismatch"); }
    if (!client) client = await this.openClient(file);
    try { await client.connect(); await client.waitForSynced(options.timeoutMs); } catch (error) { if (this.destroyed || !options.allowCachedOffline) throw error; this.setStatus("offline"); }
    this.assertLiveController();
    const current = this.fileById(file.fileId);
    if (client.isDestroyed || !current || current.state !== "live" || current.path !== path || current.documentEpoch !== file.documentEpoch) {
      this.detachDiskObserver(file.fileId);
      if (this.clients.get(file.fileId) === client) this.clients.delete(file.fileId);
      this.pool.remove(client);
      client.destroy();
      throw new Error("File changed while opening");
    }
    // (Re)mirroring onto disk: a resurrected client needs a fresh observer on
    // the new doc; attachDiskObserver no-ops when one is already live.
    if (this.materializeContext) this.attachDiskObserver(file, client, this.materializeContext.lease, this.materializeContext.callbacks);
    if (!options.sideload && (options.activateIf?.() ?? true)) {
      const previousClient = this.activeClient;
      const previousPin = this.activePin;
      this.pool.pin(client, pin);
      if (previousClient && (previousClient !== client || previousPin !== pin)) this.pool.unpin(previousClient, previousPin);
      this.activeClient = client; this.activePin = pin; this.activePath = path; this.ytext = client.doc.getText("content"); this.undoManager.destroy(); this.undoManager = new Y.UndoManager(this.ytext); this.provider = { awareness: client.awareness ?? this.fallbackAwareness }; this.awarenessVersion += 1; this.announcePresence(previousClient, client, path);
      this.emitCanWrite();
      if (!this.firstFileOpened) { this.firstFileOpened = true; const now = (this.options.now ?? Date.now)(); this.options.diagnostics?.({ name: "first_file_open", at: now, durationMs: now - this.startedAt, fileId: file.fileId }); }
    }
    return client.doc.getText("content");
  }

  private async openClient(file: CatalogFileV2): Promise<CollabTextClientV2> {
    const openingKey = `${file.fileId}:${file.documentEpoch}`;
    const pending = this.openingClients.get(openingKey);
    if (pending) return pending;
    const opening = (async () => {
      const namespace: TextNamespaceV2 = {
        deployment: this.options.deployment,
        projectInstanceId: this.options.projectInstanceId,
        fileId: file.fileId,
        documentEpoch: file.documentEpoch,
      };
      const opened = await CollabTextClientV2.open(namespace, {
        store: this.options.store ?? new CollabTextDurableStoreV2(),
        issueTicket: (identity) => this.issueTicket(identity),
        transportFactory: this.options.transportFactory ?? createYPartyTransportV2({ host: this.options.deployment }),
        reconnect: this.options.reconnectPolicy,
      });
      if (this.destroyed) {
        opened.destroy();
        throw new Error("Controller is destroyed");
      }
      const current = this.fileById(file.fileId);
      if (!current || current.documentEpoch !== file.documentEpoch) {
        opened.destroy();
        throw new Error("File epoch changed while opening");
      }
      const winner = this.clients.get(file.fileId);
      if (winner && !winner.isDestroyed && winner.namespace.documentEpoch === file.documentEpoch) {
        opened.destroy();
        return winner;
      }
      if (winner) {
        this.detachDiskObserver(file.fileId);
        winner.destroy();
      }
      this.clients.set(file.fileId, opened);
      this.pool.add(opened);
      opened.subscribeState((state) => {
        if (opened === this.activeClient) {
          this.onDurability(state);
          this.emitCanWrite();
        }
      });
      opened.subscribeTransport(() => this.onTransportReplaced(opened));
      return opened;
    })();
    this.openingClients.set(openingKey, opening);
    try {
      return await opening;
    } finally {
      if (this.openingClients.get(openingKey) === opening) this.openingClients.delete(openingKey);
    }
  }

  /**
   * Announce who we are and where we are on the active file's awareness, and
   * retract the announcement from the file we left — a pooled connection would
   * otherwise keep us visible in a room we are no longer looking at.
   */
  private announcePresence(previous: CollabTextClientV2 | undefined, client: CollabTextClientV2, path: string): void {
    if (previous && previous !== client) previous.awareness?.setLocalState(null);
    this.awarenessListener?.();
    this.awarenessListener = undefined;
    const awareness = client.awareness;
    if (!awareness) return;
    const identity = this.presenceIdentity();
    awareness.setLocalState({
      ...(awareness.getLocalState() ?? {}),
      user: { name: identity.name, color: identity.color, colorLight: identity.colorLight },
      path,
      instanceId: this.instanceId,
    });
    const onChange = () => this.schedulePeerRefresh();
    awareness.on("change", onChange);
    this.awarenessListener = () => awareness.off("change", onChange);
    this.pushPeers();
  }

  private schedulePeerRefresh(): void {
    if (this.cancelPeerRefresh || this.destroyed) return;
    this.cancelPeerRefresh = scheduleProjectFrameV2(() => {
      this.cancelPeerRefresh = undefined;
      this.pushPeers();
    });
  }

  private presenceIdentity(): { name: string; color: string; colorLight: string } {
    const name = (this.options.displayName ?? "").trim() || "Anonymous";
    const colors = peerColorForKey(`${name}\0${this.instanceId}`);
    return { name, color: colors.color, colorLight: colors.colorLight };
  }

  /** Identity for board cursor presence: same name/color as the avatar list. */
  private boardPresenceUserValue?: { id: string; name: string; color: string };
  get boardPresenceUser(): { id: string; name: string; color: string } {
    // Memoized: this feeds React effect deps downstream — a fresh object per
    // access would detach/reattach the board bridge on every render.
    if (!this.boardPresenceUserValue) {
      const identity = this.presenceIdentity();
      this.boardPresenceUserValue = { id: this.instanceId, name: identity.name, color: identity.color };
    }
    return this.boardPresenceUserValue;
  }

  /** Same-file awareness peers merged with cross-file coordinator presence. */
  private pushPeers(): void {
    const onPeers = this.options.onPeers;
    if (!onPeers || this.destroyed) return;
    const awareness = this.provider.awareness;
    const peers = readCollabPeers(awareness.getStates(), awareness.clientID);
    const seen = new Set<string>([this.instanceId]);
    for (const state of awareness.getStates().values()) {
      const instanceId = (state as { instanceId?: unknown } | null)?.instanceId;
      if (typeof instanceId === "string") {
        seen.add(instanceId);
        const peer = peers.find((candidate) => candidate.instanceId === instanceId);
        const presence = this.presenceValue[instanceId];
        if (peer && presence?.grantId) peer.grantId = presence.grantId;
      }
    }
    for (const [instanceId, entry] of Object.entries(this.presenceValue)) {
      if (seen.has(instanceId)) continue;
      peers.push({ clientId: presenceClientId(instanceId), name: entry.name, color: entry.color, path: entry.path, instanceId, ...(entry.grantId ? { grantId: entry.grantId } : {}) });
    }
    peers.sort((left, right) => left.clientId - right.clientId);
    onPeers(peers);
  }

  /** Best-effort heartbeat; the server TTL prunes us if we stay offline. */
  private async heartbeatPresence(): Promise<void> {
    if (this.presenceLeaveRequested) return;
    await this.enqueuePresence(async () => {
      if (this.destroyed || this.presenceLeaveRequested) return;
      const identity = this.presenceIdentity();
      const presence = await this.control.presence({ instanceId: this.instanceId, name: identity.name, color: identity.color, path: this.activePath || null });
      if (this.destroyed) return;
      this.presenceValue = presence;
      this.pushPeers();
    }).catch(() => { /* keep last known presence */ });
  }

  /** Ordered after any in-flight heartbeat so a late heartbeat cannot recreate our entry. */
  async leavePresence(): Promise<void> {
    if (this.presenceLeaveRequested) return this.presenceQueue;
    this.presenceLeaveRequested = true;
    return this.enqueuePresence(async () => {
      await this.control.presence({ instanceId: this.instanceId, name: "", color: "", path: null, leave: true });
    });
  }

  setActivePath(path: string, seedIfEmpty?: string): Y.Text { if (path !== this.activePath) throw new Error("v2 files must be awaited with openPath before editor binding"); if (seedIfEmpty && this.ytext.length === 0) this.ytext.insert(0, seedIfEmpty); return this.ytext; }
  renamePath(oldPath: string, newPath: string): void { const file = this.file(oldPath); if (!file) throw new Error("Unknown catalog path"); file.path = newPath; if (this.activePath === oldPath) { this.activePath = newPath; this.setAwarenessPath(newPath); } const client = this.clients.get(file.fileId); if (client) this.pool.rename(client, newPath); }
  /**
   * Add a file to the shared project mid-session. The server assigns the file
   * identity in `initializing`. Text/board content is durably imported before
   * the coordinator publishes it as live, so peers can never enter an empty
   * room between catalog publication and seeding. Binary files retain the
   * host-ready flow. Read-only actors cannot create.
   */
  async create(path: string, kind: "text" | "binary" | "board", options: { seedText?: string; timeoutMs?: number; adoptExisting?: boolean } = {}): Promise<boolean> {
    if ((this.options.permission ?? "write") === "read") throw new Error("Read-only collaborators cannot create files");
    const lease = this.requireLease();
    // Mirror the server's ensurePathFree: only states that still occupy the
    // path block creation — a tombstoned/purging entry (delete→recreate) does not.
    const existing = this.file(path);
    const occupied = existing && existing.state !== "tombstoned" && existing.state !== "purging";
    if (occupied && (!options.adoptExisting || existing.kind !== kind)) throw new Error(`File already exists in the v2 catalog: ${path}`);
    this.checkLease(lease);
    const seedText = options.seedText ?? "";
    const seedBytes = new TextEncoder().encode(seedText);
    const initializer = kind === "binary" ? undefined : {
      operationId: `initialize_${crypto.randomUUID()}`,
      size: seedBytes.byteLength,
      hash: await sha256(seedText),
    };
    const createOp = () => this.control.operation<OperationResultV2>("create", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, path, kind, ...(initializer ? { initializer } : {}) });
    let result: OperationResultV2 | undefined;
    let created: CatalogFileV2 | undefined = occupied ? existing : undefined;
    let createdByThisClient = !occupied;
    try {
      if (!created) result = await createOp();
    } catch (error) {
      // A peer moved the catalog between our last pull and this op — resync
      // and retry once.
      if (!(error instanceof CollabControlErrorV2 && error.status === 409)) throw error;
      await this.refetchCatalog();
      // The peer's move may itself have been a create at this path.
      const moved = this.file(path);
      if (moved && moved.state !== "tombstoned" && moved.state !== "purging") {
        if (moved.kind !== kind) throw new Error(`File already exists in the v2 catalog: ${path}`, { cause: error });
        created = moved;
        createdByThisClient = false;
      } else {
        result = await createOp();
      }
    }
    if (result) created = result.value as CatalogFileV2 | undefined;
    if (!created?.fileId || created.path !== path) throw new Error("The coordinator did not return the created file");
    if (result) {
      this.catalogValue.catalogRevision = result.catalogRevision;
      this.catalogValue.files.push({ ...created });
      this.locallyCreated.add(created.fileId);
      // Inline mutation bypasses refetchCatalog, so notify catalog watchers
      // (file count in the share UI) ourselves.
      this.options.onCatalog?.(this.catalogValue);
    }
    if (createdByThisClient && initializer && kind !== "binary") {
      const initialize = () => putTextFileV2({
        deployment: this.options.deployment,
        projectInstanceId: this.options.projectInstanceId,
        credential: this.credential,
        fileId: created.fileId,
        documentEpoch: created.documentEpoch,
        bytes: seedBytes,
        hash: initializer.hash,
        operationId: initializer.operationId,
      });
      try { await initialize(); }
      catch { await initialize(); }
      this.checkLease(lease);
      await this.refetchCatalog();
    }
    const now = this.options.now ?? Date.now;
    const deadline = now() + (options.timeoutMs ?? 15_000);
    while (true) {
      this.checkLease(lease);
      const entry = this.fileById(created.fileId);
      if (!entry) throw new Error("The created file vanished from the catalog");
      if (entry.state === "live") break;
      if (now() >= deadline) throw new Error(`Timed out waiting for the host to accept ${path}; it stays local until the host returns`);
      if (this.options.permission === "host" && kind === "binary") {
        // A concurrent events-poll refetch can flip the file (or move the
        // revision) first — either way the next loop iteration sees it.
        await this.fileReady(created.fileId).catch(() => undefined);
        // Happy path: file-ready flipped it inline — no backoff, no extra pull.
        if (this.fileById(created.fileId)?.state === "live") break;
      }
      // Back off between attempts and tolerate transient fetch failures —
      // the deadline, not any single poll, bounds the wait.
      await new Promise<void>((resolve) => setTimeout(resolve, this.options.permission === "host" ? 250 : 500));
      await this.refetchCatalog().catch(() => undefined);
    }
    return createdByThisClient;
  }

  async rename(oldPath: string, newPath: string, local: CollabLocalMutationsV2): Promise<string> { const file = this.file(oldPath); if (!file) throw new Error("Unknown catalog path"); const lease = this.requireLease(); const fileId = file.fileId; return this.enqueueFile(fileId, async () => { this.checkLease(lease); this.locallyRenamed.set(fileId, newPath); try { const result = await this.control.operation<{ catalogRevision: number }>("rename", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, fileId, path: newPath }); this.catalogValue.catalogRevision = result.catalogRevision; this.renamePath(oldPath, newPath); this.checkLease(lease); try { const actual = await local.rename(oldPath, newPath, lease.projectRoot); this.checkLease(lease); return actual || newPath; } catch (error) { await this.refetchCatalog().catch(() => undefined); throw error; } } finally { this.locallyRenamed.delete(fileId); } }); }
  async createInvitation(permission: "read" | "write"): Promise<string> {
    const guestSecret = randomSecret(); const salt = randomSecret();
    const hash = await sha256(`${salt}:${guestSecret}`);
    await this.control.operation("grants", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, permission, guestSecretHash: { salt, hash } });
    await this.refetchCatalog();
    // Keep the original five-field v2 wire shape so older v2 clients continue
    // accepting new invitations. Joiners read the current name from catalog.
    return formatCollabInvitationV2({ version: 2, deployment: new URL(this.options.deployment).origin + "/", projectInstanceId: this.options.projectInstanceId, guestSecret, permission });
  }
  listGrants(): Promise<Array<{ grantId: string; permission: "read" | "write"; revoked: boolean }>> { return this.control.grants(); }
  async revoke(grantId: string): Promise<void> { const result = await this.control.operation<OperationResultV2>("revoke", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, grantId }); this.catalogValue.catalogRevision = result.catalogRevision; }
  async delete(path: string, local: CollabLocalMutationsV2): Promise<void> { const file = this.file(path); if (!file) throw new Error("Unknown catalog path"); const lease = this.requireLease(); await this.enqueueFile(file.fileId, async () => { this.checkLease(lease); this.locallyDeleted.add(file.fileId); try { await this.control.operation("delete-begin", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, fileId: file.fileId }); await this.refetchCatalog(); this.detachDiskObserver(file.fileId); this.checkLease(lease); await local.delete(path, lease.projectRoot); this.checkLease(lease); } finally { this.locallyDeleted.delete(file.fileId); } }); }
  async settled(): Promise<void> { await this.activeClient?.settled(); }
  async flush(): Promise<void> {
    while (this.diskObserverFlushes.size > 0 || this.pendingDiskWrites.size > 0) {
      const flushes = [...this.diskObserverFlushes.values()];
      if (flushes.length > 0) await Promise.all(flushes.map((flush) => flush()));
      if (this.pendingDiskWrites.size > 0) await Promise.all([...this.pendingDiskWrites]);
      if (flushes.length === 0 && this.pendingDiskWrites.size === 0) break;
      if ([...this.diskObserverFlushes.values()].every((flush) => flushes.includes(flush)) && this.pendingDiskWrites.size === 0) break;
    }
  }
  async downloadBinary(path: string): Promise<Uint8Array> { const file = this.file(path); if (!file || file.kind !== "binary") throw new Error("Unknown binary catalog path"); return this.getBinaryClient().download(file.fileId, file.documentEpoch); }
  async replaceBinary(path: string, bytes: Uint8Array, mime: string, local: CollabLocalMutationsV2): Promise<BinaryReplaceResult> { const file = this.file(path); if (!file || file.kind !== "binary" || file.state !== "live") throw new Error("Unknown binary catalog path"); const lease = this.requireLease(); return this.enqueueFile(file.fileId, async () => { this.checkLease(lease); const result = await this.getBinaryClient().replace(file.fileId, file.documentEpoch, bytes, mime, this.catalogValue.catalogRevision, file.contentRevision ?? 0, file.hash); this.checkLease(lease); if (result.status === "conflict") { const loser = await this.getBinaryClient().download(file.fileId, file.documentEpoch, result.conflict.conflictId); this.checkLease(lease); if (!local.writeBinaryConflict) throw new Error("Binary conflict requires an explicit conflict-copy writer"); await local.writeBinaryConflict(binaryConflictPath(path, result.conflict.conflictId), loser, lease.projectRoot); this.options.onPermanentError?.(new Error(`Binary conflict preserved for ${path}`), file.fileId); } await this.refetchCatalog().catch(() => undefined); return result; }); }
  /**
   * Attach a workspace lease + disk callbacks without materializing. The host
   * of a share already has the project on disk, so it must not rewrite every
   * file from the server — but it still needs peer tree changes reconciled.
   */
  bindWorkspace(lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2): void {
    this.assertLiveController();
    if (this.materializeLease && this.materializeLease !== lease) throw new Error("Controller is already bound to a workspace lease");
    this.materializeLease = lease;
    this.materializeContext = { lease, callbacks };
    this.binaryClient ??= new CollabBinaryV2Client(this.options.deployment, this.options.projectInstanceId, this.credential, () => this.checkLease(lease));
  }

  async materializeProject(lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2): Promise<CollabMaterializeResultV2> {
    this.assertLiveController();
    this.bindWorkspace(lease, callbacks);
    const files = this.catalogFiles().filter((file) => file.state === "live");
    const textFiles = files.filter((file) => file.kind !== "binary");
    const openPath = chooseRootTextPath(textFiles);
    const checkLease = () => { if (!lease.isCurrent()) throw new Error("Collaboration workspace lease expired"); };
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= files.length) return;
        const file = files[index];
        checkLease();
        if (file.kind !== "binary") {
          // Sideload: materialization must not steal the editor's active
          // binding (or flap presence across every file) per opened document.
          const text = await this.openPath(file.path, "secondary", { sideload: true });
          await this.clients.get(file.fileId)?.settled();
          checkLease();
          const client = this.clients.get(file.fileId);
          const content = file.kind === "board" && client
            ? (await import("./board-yjs-bridge")).boardDocContent(client.doc)
            : text.toString();
          await this.enqueueFile(file.fileId, () => callbacks.writeText(file.path, content, lease.projectRoot));
          if (client) this.attachDiskObserver(file, client, lease, callbacks);
        } else {
          const bytes = await this.downloadBinary(file.path);
          checkLease();
          await callbacks.writeBytes(file.path, bytes, lease.projectRoot);
        }
        checkLease();
      }
    };
    const concurrency = Math.max(1, Math.min(16, callbacks.concurrency ?? 4, files.length || 1));
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (!openPath) throw new Error("The shared project has no live text files");
    return { rootPath: lease.projectRoot, openPath, textCount: textFiles.length, binaryCount: files.length - textFiles.length, fileCount: files.length };
  }
  async close(): Promise<void> {
    if (this.catalogValue.lifecycle === "closing" || this.catalogValue.lifecycle === "closed") return;
    const result = await this.control.operation<OperationResultV2>("close-begin", { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision });
    this.catalogValue.catalogRevision = result.catalogRevision;
    this.catalogValue.lifecycle = result.status === "pending" ? "closing" : "closed";
    this.options.onCatalog?.(this.catalogValue);
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true; this.stopEventsPolling();
    this.cancelPeerRefresh?.(); this.cancelPeerRefresh = undefined;
    this.awarenessListener?.(); this.awarenessListener = undefined;
    // Best-effort leave so our entry does not linger until the server TTL.
    if (this.control) void this.leavePresence().catch(() => undefined);
    for (const detach of this.diskObservers.values()) detach(); this.diskObservers.clear(); for (const client of this.clients.values()) client.destroy(); this.clients.clear(); this.canWriteListeners.clear(); this.undoManager.destroy(); this.fallbackAwareness.destroy(); this.fallbackDoc.destroy();
  }

  private file(path: string): CatalogFileV2 | undefined { return this.catalogValue.files.find((entry) => entry.path === path); }
  private fileById(fileId: string): CatalogFileV2 | undefined { return this.catalogValue.files.find((entry) => entry.fileId === fileId); }
  private checkLease(lease: CollabMaterializeLeaseV2): void { this.assertLiveController(); if (!lease.isCurrent()) throw new Error("Collaboration workspace lease expired"); }
  private requireLease(): CollabMaterializeLeaseV2 { if (!this.materializeLease) throw new Error("Controller has no workspace lease"); this.checkLease(this.materializeLease); return this.materializeLease; }
  private getBinaryClient(): CollabBinaryV2Client { if (this.binaryClient) return this.binaryClient; const lease = this.requireLease(); return this.binaryClient = new CollabBinaryV2Client(this.options.deployment, this.options.projectInstanceId, this.credential, () => this.checkLease(lease)); }
  private enqueueFile<T>(fileId: string, mutation: () => Promise<T>): Promise<T> { const prior = this.fileMutations.get(fileId) ?? Promise.resolve(); const result = prior.catch(() => undefined).then(mutation); const tail = result.then(() => undefined, () => undefined); this.fileMutations.set(fileId, tail); void tail.finally(() => { if (this.fileMutations.get(fileId) === tail) this.fileMutations.delete(fileId); }); return result; }
  private enqueuePresence(operation: () => Promise<void>): Promise<void> {
    const result = this.presenceQueue.catch(() => undefined).then(operation);
    this.presenceQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  private detachDiskObserver(fileId: string): void { this.diskObservers.get(fileId)?.(); this.diskObservers.delete(fileId); }
  private trackDiskWrite(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => this.pendingDiskWrites.delete(tracked));
    this.pendingDiskWrites.add(tracked);
    return tracked;
  }
  /** Mirror remote edits of a synced text-family file onto the workspace disk. */
  private attachDiskObserver(file: CatalogFileV2, client: CollabTextClientV2, lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2): void {
    if (this.diskObservers.has(file.fileId)) return;
    const fileId = file.fileId; const documentEpoch = file.documentEpoch;
    // Boards keep live state in the records map, so watching only the content
    // Y.Text would mirror the stale import forever; boardDocContent serializes
    // records on demand. The serializer is lazily imported so tldraw stays out
    // of the main bundle.
    const write = async () => {
      if (!lease.isCurrent()) return;
      await this.enqueueFile(fileId, async () => {
        this.checkLease(lease);
        const current = this.fileById(fileId);
        if (!current || current.state !== "live" || current.documentEpoch !== documentEpoch) { this.detachDiskObserver(fileId); return; }
        const path = current.path;
        this.checkLease(lease);
        const content = file.kind === "board"
          ? (await import("./board-yjs-bridge")).boardDocContent(client.doc)
          : client.doc.getText("content").toString();
        await callbacks.writeText(path, content, lease.projectRoot);
        this.checkLease(lease);
      });
    };
    if (file.kind === "board") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pendingWrites = new Set<Promise<void>>();
      const startWrite = () => {
        const pending = this.trackDiskWrite(write());
        pendingWrites.add(pending);
        void pending.catch((error) => this.options.onPermanentError?.(
          error instanceof Error ? error : new Error(String(error)),
          fileId,
        )).finally(() => pendingWrites.delete(pending));
      };
      const scheduleWrite = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          startWrite();
        }, BOARD_DISK_WRITE_DEBOUNCE_MS);
      };
      const flush = async () => {
        while (timer !== undefined || pendingWrites.size > 0) {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
            startWrite();
          }
          await Promise.all([...pendingWrites]);
        }
      };
      this.diskObserverFlushes.set(fileId, flush);
      // Both local and remote record edits must reach the workspace .tldr.
      // Coalesce pointer-frequency drawing updates into one latest-state write.
      const onUpdate = () => scheduleWrite();
      client.doc.on("update", onUpdate);
      // Initial sync completes before this observer is attached. Persist the
      // already-converged state even if no later update wakes the observer.
      scheduleWrite();
      this.diskObservers.set(fileId, () => {
        client.doc.off("update", onUpdate);
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        this.diskObserverFlushes.delete(fileId);
      });
    } else {
      const text = client.doc.getText("content");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: Promise<void> | undefined;
      let dirty = false;
      const startWrite = () => {
        if (pending) { dirty = true; return; }
        dirty = false;
        pending = this.trackDiskWrite(write()).catch((error) => this.options.onPermanentError?.(
          error instanceof Error ? error : new Error(String(error)),
          fileId,
        )).finally(() => {
          pending = undefined;
          if (dirty) scheduleWrite();
        });
      };
      const scheduleWrite = () => {
        dirty = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          startWrite();
        }, TEXT_DISK_WRITE_DEBOUNCE_MS);
      };
      const flush = async () => {
        while (timer !== undefined || pending || dirty) {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
            startWrite();
          } else if (!pending && dirty) {
            startWrite();
          }
          if (pending) await pending;
        }
      };
      this.diskObserverFlushes.set(fileId, flush);
      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (!transaction.local) scheduleWrite();
      };
      text.observe(observer);
      // Initial synchronization also completes before this observer exists.
      scheduleWrite();
      this.diskObservers.set(fileId, () => {
        text.unobserve(observer);
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        dirty = false;
        this.diskObserverFlushes.delete(fileId);
      });
    }
  }
  private reconcileDiskObservers(): void { for (const [fileId] of this.diskObservers) { const file = this.fileById(fileId); const client = this.clients.get(fileId); if (!file || file.state !== "live" || file.kind === "binary" || !client || client.isDestroyed || client.namespace.documentEpoch !== file.documentEpoch) this.detachDiskObserver(fileId); } }
  private async issueTicket(namespace: TextNamespaceV2): Promise<string> { const value = await this.control.operation<{ ticket: string }>("tickets", { audience: "file", fileId: namespace.fileId, documentEpoch: namespace.documentEpoch }); if (!value.ticket) throw new Error("Ticket issuer returned no ticket"); return value.ticket; }
  private onDurability(state: TextDurabilityStateV2): void {
    // Lifecycle states are sticky: a late durable-ack must not flip a closed,
    // offline, importing, or failed project back to "durable".
    if (this.statusValue === "closed" || this.statusValue === "offline" || this.statusValue === "importing" || this.statusValue === "error") return;
    this.setStatus(state === "server-durable" || state === "clean" ? "durable" : "syncing");
  }
  private setStatus(status: CollabProjectStatusV2): void { if (this.destroyed || this.statusValue === status) return; this.statusValue = status; this.options.onStatus?.(status); }
  private assertLiveController(): void { if (this.destroyed) throw new Error("Controller is destroyed"); }
}

function randomSecret(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value: string): Promise<string> { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function chooseRootTextPath(files: CatalogFileV2[]): string {
  return files.find((file) => /(^|\/)main\.(md|tex|txt)$/i.test(file.path))?.path
    ?? files.find((file) => !file.path.includes("/"))?.path
    ?? files[0]?.path
    ?? "";
}
function binaryConflictPath(path: string, conflictId: string): string { const dot = path.lastIndexOf("."); const suffix = `.conflict-${conflictId.slice(0, 8)}`; return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`; }
