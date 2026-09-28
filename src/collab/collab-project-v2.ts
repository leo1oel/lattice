import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { CatalogFileV2, CatalogV2, OperationResultV2 } from "../../protocol/collab-v2";
import { randomSecret, sha256Hex } from "../../protocol/encoding";
import { CollabControlErrorV2, CollabControlV2Client } from "./collab-control-v2";
import type { CollabCredentialStore } from "./collab-credentials";
import { CollabTextDurableStoreV2, type TextNamespaceV2 } from "./collab-text-v2-store";
import { CollabTextClientV2, CollabTextProviderPoolV2, createYPartyTransportV2, isClientDestroyedErrorV2, type CollabTextPinV2, type ReconnectPolicyV2, type TextDurabilityStateV2, type TextTransportFactoryV2 } from "./collab-text-v2";
import { keyedQueue } from "./collab-workspace-lease";
import { CollabBinaryV2Client, type BinaryReplaceResult } from "./collab-binary-v2";
import { CollabDiskMirrorV2, serializeCollabFileV2 } from "./collab-disk-mirror-v2";
import { formatCollabInvitationV2 } from "./collab-invitation-v2";
import { mergeTextIntoYText, type CollabPeer } from "./collab-session";
import { planCatalogDeltaV2 } from "./collab-catalog-delta-v2";
import { CollabPresenceV2 } from "./collab-presence-v2";
import { COLLAB_CHAT_PATH } from "./use-collab-chat";
import { EDITOR_COMMENTS_PATH } from "../editor/comments/editor-comment-data";
import { putTextFileV2 } from "./collab-import-v2";
import { isPaperLibraryPath } from "../papers/paper-link";
import type { DiagnosticOperationContext } from "../telemetry/diagnostic-request";
import { mayResumeCollabProject } from "./collab-feature-policy";

type CollabDiagnosticV2 = { name: "join_latency" | "first_file_open" | "events_poll_error"; at: number; durationMs?: number; fileId?: string };
export type CollabProjectStatusV2 = "syncing" | "server-received" | "durable" | "offline" | "read-only" | "importing" | "closed" | "error";
export type CollabProjectV2Options = {
  deployment: string; projectInstanceId: string; credentialRef: string; credentialStore: CollabCredentialStore;
  store?: CollabTextDurableStoreV2; transportFactory?: TextTransportFactoryV2; poolCapacity?: number;
  /** How often the controller polls the coordinator's event stream for peer catalog changes. */
  eventsPollIntervalMs?: number;
  /** Shown to collaborators in presence and cursor labels. */
  displayName?: string;
  /** Stable person identity shared with comment authorship, used only to choose a consistent color. */
  participantId?: string;
  /**
   * Our actor's permission. "read" blocks local creates; "host" additionally
   * takes on the catalog duty of marking peer-created (initializing) files
   * live, which the server only allows the host to do.
   */
  permission?: "host" | "write" | "read";
  onStatus?: (status: CollabProjectStatusV2) => void; onCatalog?: (catalog: CatalogV2) => void;
  /** Live peer list: same-file awareness merged with cross-file coordinator presence. */
  onPeers?: (peers: CollabPeer[]) => void;
  onPermanentError?: (error: Error, fileId?: string) => void; diagnostics?: (event: CollabDiagnosticV2) => void; now?: () => number;
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
type OpenPathOptionsV2 = { allowCachedOffline?: boolean; cachedFirst?: boolean; timeoutMs?: number; sideload?: boolean; activateIf?: () => boolean };
export type CollabLocalMutationsV2 = {
  rename(oldPath: string, newPath: string, projectRoot: string): Promise<string | void>;
  delete(path: string, projectRoot: string): Promise<void>;
  writeBinaryConflict?(path: string, bytes: Uint8Array, projectRoot: string): Promise<void>;
};
type CollabMaterializeResultV2 = { rootPath: string; openPath: string; textCount: number; binaryCount: number; fileCount: number };
const EXTERNAL_TEXT_SNAPSHOT_ORIGIN_V2 = Symbol("v2-external-text-snapshot");
type SideloadedTextIdentityV2 = { projectInstanceId: string; fileId: string; documentEpoch: number };
export type SideloadedTextBindingV2 = {
  readonly bindingId: string; readonly identity: SideloadedTextIdentityV2; readonly doc: Y.Doc; readonly ytext: Y.Text;
  readonly version: number; readonly canWrite: boolean; readonly durabilityState: TextDurabilityStateV2;
  subscribeCanWrite(listener: (canWrite: boolean) => void): () => void;
  subscribeDurability(listener: (state: TextDurabilityStateV2) => void): () => void;
  applyExternalDocument(update: (doc: Y.Doc) => void, expectedVersion?: number): number;
  applyExternalText(text: string, expectedVersion?: number): number;
  release(): void;
};
type StructuredDocumentV2 = { doc: Y.Doc; awareness: Awareness | null; canWrite: boolean };

/**
 * A catalog document held open for the whole session: project chat and editor
 * comments. Both are opened sideloaded so they never steal the editor's
 * binding, and pinned because an unpinned clean client is fair game for pool
 * eviction — which used to leave the panel watching a destroyed document, so a
 * peer's change reached nobody and the next local edit went to a freshly
 * resurrected one. Subscribers re-bind when an epoch change replaces the doc.
 */
type PinnedDocV2 = { path: string; pinName: string; client?: CollabTextClientV2; pin?: CollabTextPinV2; listeners: Set<(doc: Y.Doc | null) => void> };


/** Mirrors the server's ensurePathFree: a tombstoned or purging entry (delete → recreate) no longer occupies its path. */
function occupiesPath(file: CatalogFileV2 | undefined): file is CatalogFileV2 {
  return !!file && file.state !== "tombstoned" && file.state !== "purging";
}

/** One v2 project session. The catalog owns paths; each immutable file identity owns its own Y.Doc. */
export class CollabProjectControllerV2 {
  readonly room: string;
  readonly host: string;
  private control!: CollabControlV2Client;
  private catalogValue!: CatalogV2;
  private readonly clients = new Map<string, CollabTextClientV2>();
  private readonly openingClients = new Map<string, Promise<CollabTextClientV2>>();
  private readonly canWriteListeners = new Set<(canWrite: boolean) => void>();
  /** Mutations of one file run in order; a failure does not block the next. */
  private readonly enqueueFile = keyedQueue();
  private readonly pool: CollabTextProviderPoolV2;
  private readonly fallbackDoc = new Y.Doc();
  private fallbackAwareness = new Awareness(this.fallbackDoc);
  private activeClient?: CollabTextClientV2;
  private activePin?: CollabTextPinV2;
  private secondaryClient?: CollabTextClientV2;
  private secondaryPin?: CollabTextPinV2;
  private secondaryPath?: string;
  private secondaryUndoManager?: Y.UndoManager;
  private secondaryOpenGeneration = 0;
  private readonly secondaryBindingListeners = new Set<() => void>();
  private readonly chat: PinnedDocV2 = { path: COLLAB_CHAT_PATH, pinName: "chat", listeners: new Set() };
  private readonly comments: PinnedDocV2 = { path: EDITOR_COMMENTS_PATH, pinName: "comments", listeners: new Set() };
  private readonly sideloadedBindings = new Set<SideloadedTextBindingV2>();
  private readonly sideloadedCanWriteRefresh = new Set<() => void>();
  private destroyed = false;
  private firstFileOpened = false;
  private statusValue: CollabProjectStatusV2 = "syncing";
  private credential = "";
  private readonly durableStore: CollabTextDurableStoreV2;
  /** True while catalogValue came from IndexedDB rather than this session's coordinator. */
  private catalogOffline = false;
  private workspace?: { lease: CollabMaterializeLeaseV2; callbacks: CollabMaterializeCallbacksV2 };
  private readonly diskMirror = new CollabDiskMirrorV2({
    fileById: (fileId) => this.fileById(fileId),
    enqueueFile: (fileId, mutation) => this.enqueueFile(fileId, mutation),
    checkLease: (lease) => this.checkLease(lease),
    report: (error, fileId) => this.report(error, fileId),
  });
  private binaryClient?: CollabBinaryV2Client;
  private eventsTimer?: ReturnType<typeof setInterval>;
  private eventsPolling = false;
  private finalizingInitializing = false;
  private readonly presence: CollabPresenceV2;
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

  private constructor(private readonly options: CollabProjectV2Options, private readonly startedAt: number) {
    this.room = options.projectInstanceId; this.host = options.deployment;
    this.durableStore = options.store ?? new CollabTextDurableStoreV2();
    this.pool = new CollabTextProviderPoolV2(options.poolCapacity ?? 8, options.now);
    this.presence = new CollabPresenceV2({
      displayName: options.displayName,
      participantId: options.participantId,
      onPeers: options.onPeers,
      control: () => this.control,
      awareness: () => this.provider.awareness,
      activePath: () => this.activePath,
    });
  }

  static async start(options: CollabProjectV2Options): Promise<CollabProjectControllerV2> {
    if (!mayResumeCollabProject()) throw new Error("collaboration_reads_disabled");
    const controller = new CollabProjectControllerV2(options, (options.now ?? Date.now)());
    const credential = await options.credentialStore.get(options.credentialRef, options.projectInstanceId, options.deployment);
    if (!credential) throw new Error("Collaboration credential is unavailable");
    controller.control = new CollabControlV2Client(options.deployment, options.projectInstanceId, credential);
    controller.credential = credential;
    try {
      await controller.refetchCatalog();
      controller.diagnose("join_latency");
    } catch (error) {
      // A transient failure with a cached catalog cold-opens offline: cached
      // documents stay editable, and catalog changes wait for reconnection.
      const cached = isTransientCatalogFailure(error)
        ? await controller.durableStore.loadCatalog(options.deployment, options.projectInstanceId).catch(() => undefined)
        : undefined;
      if (!cached) { controller.setStatus("offline"); throw error; }
      controller.catalogValue = cached;
      controller.catalogOffline = true;
      options.onCatalog?.(cached);
      controller.setStatus("offline");
    }
    controller.startEventsPolling(options.eventsPollIntervalMs ?? 3_000);
    return controller;
  }

  get doc(): Y.Doc { return this.activeClient?.doc ?? this.fallbackDoc; }
  get status(): CollabProjectStatusV2 { return this.statusValue; }
  get canWrite(): boolean { return !this.readOnly && !this.activeClient?.isStopped; }
  private get readOnly(): boolean { return (this.options.permission ?? "write") === "read"; }

  subscribeCanWrite = (listener: (canWrite: boolean) => void): (() => void) => {
    this.canWriteListeners.add(listener);
    listener(this.canWrite);
    return () => this.canWriteListeners.delete(listener);
  };

  private emitCanWrite(): void {
    const value = this.canWrite;
    for (const listener of this.canWriteListeners) listener(value);
  }

  fileCount(): number { return this.catalogValue.files.filter((file) => file.state === "live").length; }
  catalogFiles(): CatalogFileV2[] { return this.catalogValue.files.map((file) => ({ ...file })); }
  catalogTextPaths(): string[] { return this.catalogValue.files.filter((file) => file.state === "live" && file.kind !== "binary").map((file) => file.path); }
  hasTextPath(path: string): boolean { return this.catalogTextPaths().includes(path); }
  hasSpreadsheetPath(path: string): boolean {
    const file = this.file(path);
    return file?.state === "live" && file.kind === "spreadsheet";
  }

  // --- Session-long catalog documents -------------------------------------

  subscribeChatDoc = (listener: (doc: Y.Doc | null) => void): (() => void) => {
    this.chat.listeners.add(listener);
    listener(this.chat.client && !this.chat.client.isDestroyed ? this.chat.client.doc : null);
    return () => this.chat.listeners.delete(listener);
  };

  /**
   * Open (creating on first use) the project-wide chat document. In v2 every
   * file is its own Y.Doc, so chat rides one dedicated catalog file.
   */
  openChatDoc(): Promise<Y.Doc | null> { return this.openPinned(this.chat); }

  /** The room's comments document, kept alive for the session. */
  openCommentsDoc(): Promise<Y.Doc | null> { return this.openPinned(this.comments); }

  /**
   * Idempotent; safe to re-run on every catalog change. Returns null when the
   * file does not exist yet and this actor cannot create it — a read-only guest
   * before any writer has opened it, or a writer whose workspace lease is not
   * bound yet. Callers simply retry on the next catalog movement.
   */
  private async openPinned(slot: PinnedDocV2): Promise<Y.Doc | null> {
    this.assertLiveController();
    const entry = this.file(slot.path);
    const live = occupiesPath(entry);
    if (slot.client) {
      if (!slot.client.isDestroyed && live && entry.documentEpoch === slot.client.namespace.documentEpoch) return slot.client.doc;
      // Destroyed, tombstoned, or epoch-bumped — drop and rebind below.
      this.bindPinned(slot, undefined);
    }
    if (!live) {
      if (this.readOnly || !this.workspace) return null;
      await this.create(slot.path, "text", { seedText: "", adoptExisting: true });
    }
    await this.openPath(slot.path, "secondary", { sideload: true, allowCachedOffline: true });
    const file = this.file(slot.path);
    const client = file ? this.clients.get(file.fileId) : undefined;
    if (!client || client.isDestroyed) return null;
    slot.pin?.release();
    slot.pin = this.pool.pin(client, slot.pinName);
    this.bindPinned(slot, client);
    return client.doc;
  }

  private bindPinned(slot: PinnedDocV2, client: CollabTextClientV2 | undefined): void {
    slot.client = client;
    for (const listener of slot.listeners) listener(client?.doc ?? null);
  }

  // --- Catalog and peer events ---------------------------------------------

  async refetchCatalog(): Promise<CatalogV2> {
    this.assertLiveController();
    const catalog = await this.control.catalog();
    this.assertLiveController();
    if (catalog.projectInstanceId !== this.options.projectInstanceId) throw new Error("Catalog project identity mismatch");
    await this.durableStore.persistCatalog(this.options.deployment, this.options.projectInstanceId, catalog);
    this.assertLiveController();
    this.catalogValue = catalog;
    this.catalogOffline = false;
    for (const refresh of this.sideloadedCanWriteRefresh) refresh();
    this.diskMirror.retain((fileId) => {
      const file = this.fileById(fileId);
      const client = this.clients.get(fileId);
      return file?.state === "live" && file.kind !== "binary" && !!client && !client.isDestroyed && client.namespace.documentEpoch === file.documentEpoch;
    });
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
  private async finalizeInitializingFiles(): Promise<void> {
    // The sweep fires on every refetch; overlap would double file-ready the
    // same file (the second call 400s as "not initializing").
    if (this.finalizingInitializing) return;
    this.finalizingInitializing = true;
    try {
      for (const file of this.catalogValue.files.filter((entry) => entry.state === "initializing" && entry.kind === "binary")) {
        await this.fileReady(file.fileId).catch((error) => this.report(error, file.fileId));
      }
    } finally {
      this.finalizingInitializing = false;
    }
  }

  /** Host-only catalog op: flip an initializing file to live. */
  private async fileReady(fileId: string): Promise<void> {
    const result = await this.operation("file-ready", { fileId });
    this.assertLiveController();
    this.catalogValue.catalogRevision = result.catalogRevision;
    const entry = this.fileById(fileId);
    if (entry && entry.state === "initializing") entry.state = "live";
  }

  /**
   * Pull the coordinator's event stream; on any catalog movement refetch and
   * reconcile the local workspace tree (peer creates/renames/deletes/binary
   * replacements) onto disk.
   */
  private async fetchEvents(): Promise<void> {
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
    await this.refetchAndReconcile(previous);
  }

  /** `previous` is captured before any await, so a refetch racing in between still gets reconciled. */
  private async refetchAndReconcile(previous = this.catalogValue): Promise<void> {
    await this.refetchCatalog();
    await this.reconcileCatalogDelta(previous);
  }

  private startEventsPolling(intervalMs: number): void {
    this.eventsTimer ??= setInterval(() => { void this.pollEvents(); }, intervalMs);
  }

  private async pollEvents(): Promise<void> {
    if (this.destroyed || this.eventsPolling) return;
    if (this.catalogValue?.lifecycle === "closed") { this.stopEventsPolling(); return; }
    this.eventsPolling = true;
    try {
      if (this.catalogOffline) {
        await this.refetchAndReconcile();
      } else {
        await this.presence.heartbeat();
        await this.fetchEvents();
      }
    } catch {
      this.options.diagnostics?.({ name: "events_poll_error", at: this.now() });
    } finally {
      this.eventsPolling = false;
    }
  }

  private stopEventsPolling(): void {
    clearInterval(this.eventsTimer);
    this.eventsTimer = undefined;
  }

  /**
   * Apply the tree-level delta between an earlier catalog snapshot and the
   * current one to the materialized workspace. Text *content* never needs
   * this — Yjs sync plus the disk mirror cover it — but structure changes
   * (create/rename/delete, binary replacement) only exist server-side until a
   * peer pulls them down. Operations this client initiated are skipped: they
   * already mutated the local tree (and `catalogValue`) inline.
   */
  private async reconcileCatalogDelta(previous: CatalogV2): Promise<void> {
    if (!this.workspace || this.destroyed) return;
    const { lease, callbacks } = this.workspace;
    const plan = planCatalogDeltaV2(previous, this.catalogValue);
    const apply = (fileId: string, mutation: () => Promise<unknown>) =>
      this.enqueueFile(fileId, async () => { this.checkLease(lease); await mutation(); }).catch((error) => this.report(error, fileId));

    for (const { file, previousPath } of plan.renamed) {
      if (this.locallyRenamed.get(file.fileId) === file.path || isPaperLibraryPath(file.path) || isPaperLibraryPath(previousPath)) continue;
      this.followRename(file.fileId, previousPath, file.path);
      if (callbacks.rename) await apply(file.fileId, () => callbacks.rename!(previousPath, file.path, lease.projectRoot));
    }

    for (const file of plan.created) {
      // A binary with no hash was created mid-share and its upload is still in
      // flight; the staleBinaries pass after its commit pulls the bytes.
      if (this.locallyCreated.has(file.fileId) || isPaperLibraryPath(file.path) || (file.kind === "binary" && !file.hash)) continue;
      await apply(file.fileId, () => {
        if (file.kind !== "binary") {
          this.diskMirror.detach(file.fileId);
          const stale = this.clients.get(file.fileId);
          if (stale && stale.namespace.documentEpoch !== file.documentEpoch) this.discardClient(file.fileId, stale);
        }
        return this.pullFile(file, lease, callbacks, { allowCachedOffline: true });
      });
    }

    const refreshed = new Set(plan.created.map((file) => file.fileId));
    for (const file of plan.staleBinaries) {
      if (refreshed.has(file.fileId) || isPaperLibraryPath(file.path)) continue;
      await apply(file.fileId, () => this.pullFile(file, lease, callbacks));
    }

    for (const { fileId, path } of plan.deleted) {
      this.diskMirror.detach(fileId);
      if (this.locallyDeleted.has(fileId) || isPaperLibraryPath(path)) continue;
      // An epoch bump reusing the same path shows up as delete+create; the
      // create already rewrote the content, so deleting would remove the live file.
      if (this.catalogValue.files.some((file) => file.state === "live" && file.path === path)) continue;
      if (callbacks.delete) await apply(fileId, () => callbacks.delete!(path, lease.projectRoot));
    }
  }

  /** Keep the active binding and pool recency in step with a catalog rename. */
  private followRename(fileId: string, oldPath: string, newPath: string): void {
    this.clients.get(fileId)?.touch();
    if (this.activePath !== oldPath) return;
    this.activePath = newPath;
    const awareness = this.provider.awareness;
    awareness.setLocalState({ ...(awareness.getLocalState() ?? {}), path: newPath });
  }

  // --- Opening documents ---------------------------------------------------

  async openPath(path: string, pin: "main" | "secondary" = "main", options: OpenPathOptionsV2 = {}): Promise<Y.Text> {
    return this.openPathAttempt(path, pin, options, true);
  }

  private async openPathAttempt(path: string, pin: "main" | "secondary", options: OpenPathOptionsV2, retryEvicted: boolean): Promise<Y.Text> {
    this.assertLiveController();
    const file = this.file(path);
    if (!file) throw new Error(`File is not in the v2 catalog: ${path}`);
    if (file.state !== "live" && file.state !== "initializing") throw new Error("File is unavailable");
    let client = this.clients.get(file.fileId);
    // The provider pool evicts (destroys) unpinned clean clients without
    // notifying us; a destroyed client must be resurrected rather than reused,
    // otherwise connect() throws "Client is destroyed" forever.
    if (client?.isDestroyed) { this.discardClient(file.fileId, client); client = undefined; }
    if (client && client.namespace.documentEpoch !== file.documentEpoch) {
      this.discardClient(file.fileId, client);
      this.report(new Error("File epoch changed; export cached recovery before reopening"), file.fileId);
      throw new Error("File epoch mismatch");
    }
    const opened = client ?? await this.openClient(file);
    const sync = () => opened.connect().then(() => opened.waitForSynced(options.timeoutMs));
    const catalogMoved = () => {
      const current = this.fileById(file.fileId);
      return !current || current.state !== "live" || current.path !== path || current.documentEpoch !== file.documentEpoch;
    };
    if ((options.cachedFirst || this.catalogOffline) && opened.hasSyncedSnapshot) {
      // A server-acked snapshot is already in the doc (restored from the
      // durable store at open) — return it now instead of holding the file
      // switch on ticket + WebSocket + sync. The connection proceeds in the
      // background: remote diffs merge in through the binding when it lands,
      // and failures surface as offline status, like allowCachedOffline.
      // Server-side write gating is untouched — a 4403 close still stops the
      // client and drops canWrite via subscribeState.
      void sync().catch(() => { if (!this.destroyed) this.setStatus("offline"); });
    } else {
      try {
        await sync();
      } catch (error) {
        if (!this.destroyed && isClientDestroyedErrorV2(error)) {
          const retry = retryEvicted && !catalogMoved();
          this.discardClient(file.fileId, opened);
          if (retry) return this.openPathAttempt(path, pin, options, false);
          throw new Error("File changed while opening", { cause: error });
        }
        if (this.destroyed || !options.allowCachedOffline) throw error;
        this.setStatus("offline");
      }
    }
    this.assertLiveController();
    const moved = catalogMoved();
    if (opened.isDestroyed || moved) {
      // A clean sideload may be evicted between the provider's sync event and
      // this continuation. Reopen once when the catalog identity is unchanged;
      // real renames, deletes and epoch changes must still fail closed.
      const retry = retryEvicted && opened.isDestroyed && !moved;
      this.discardClient(file.fileId, opened);
      if (retry) return this.openPathAttempt(path, pin, options, false);
      throw new Error("File changed while opening");
    }
    // (Re)mirroring onto disk: a resurrected client needs a fresh observer on
    // the new doc; attach no-ops when one is already live.
    if (this.workspace) this.diskMirror.attach(file, opened.doc, this.workspace.lease, this.workspace.callbacks);
    if (!options.sideload && (options.activateIf?.() ?? true)) this.activate(opened, path, pin, file.fileId);
    return opened.doc.getText("content");
  }

  /** Make `client` the primary editor binding: text, undo history, awareness and presence all follow it. */
  private activate(client: CollabTextClientV2, path: string, pin: "main" | "secondary", fileId: string): void {
    const previous = this.activeClient;
    if (previous !== client || !this.activePin) {
      this.activePin?.release();
      this.activePin = this.pool.pin(client, pin);
    }
    this.activeClient = client;
    this.activePath = path;
    this.ytext = client.doc.getText("content");
    this.undoManager.destroy();
    this.undoManager = new Y.UndoManager(this.ytext);
    this.provider = { awareness: client.awareness ?? this.fallbackAwareness };
    this.awarenessVersion += 1;
    // Retract our announcement from the file we left — a pooled connection
    // would otherwise keep us visible in a room we are no longer looking at.
    if (previous && previous !== client) previous.awareness?.setLocalState(null);
    this.presence.announce(client.awareness, path);
    this.emitCanWrite();
    if (!this.firstFileOpened) {
      this.firstFileOpened = true;
      this.diagnose("first_file_open", fileId);
    }
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
        store: this.durableStore,
        issueTicket: (identity) => this.issueTicket(identity),
        transportFactory: this.options.transportFactory ?? createYPartyTransportV2({ host: this.options.deployment }),
        reconnect: this.options.reconnectPolicy,
      });
      const rejectWith = (message: string): never => { opened.destroy(); throw new Error(message); };
      if (this.destroyed) rejectWith("Controller is destroyed");
      if (this.fileById(file.fileId)?.documentEpoch !== file.documentEpoch) rejectWith("File epoch changed while opening");
      const winner = this.clients.get(file.fileId);
      if (winner && !winner.isDestroyed && winner.namespace.documentEpoch === file.documentEpoch) {
        opened.destroy();
        return winner;
      }
      if (winner) {
        this.diskMirror.detach(file.fileId);
        winner.destroy();
      }
      this.clients.set(file.fileId, opened);
      this.pool.add(opened);
      opened.subscribeState((state) => {
        if (opened !== this.activeClient) return;
        this.onDurability(state);
        this.emitCanWrite();
      });
      opened.subscribePermanentError((error) => this.options.onPermanentError?.(error, file.fileId));
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

  /** Reconnects replace a client's transport and Awareness; follow the swap. */
  private onTransportReplaced(client: CollabTextClientV2): void {
    if (this.destroyed || client.isDestroyed) return;
    if (client === this.secondaryClient) {
      this.awarenessVersion += 1;
      for (const listener of this.secondaryBindingListeners) listener();
    }
    if (client !== this.activeClient) return;
    const awareness = client.awareness ?? this.fallbackAwareness;
    if (this.provider.awareness === awareness) return;
    this.provider = { awareness };
    this.awarenessVersion += 1;
    // Re-announce identity/path and rebind the peers listener on the new
    // Awareness — the old object no longer reaches the network.
    this.presence.announce(client.awareness, this.activePath);
  }

  /** Opens a text document for a managed workspace without changing the primary editor binding or presence. */
  async openSideloadedText(path: string, bindingId: string): Promise<SideloadedTextBindingV2> {
    this.assertLiveController();
    if (!bindingId) throw new Error("A binding id is required");
    const file = this.file(path);
    if (!file || file.kind === "binary" || file.state !== "live") throw new Error("Text-family file is unavailable");
    await this.openPath(path, "secondary", { sideload: true });
    this.assertLiveController();
    const client = this.clients.get(file.fileId);
    const current = this.fileById(file.fileId);
    if (!client || client.isDestroyed || !current || current.state !== "live" || current.documentEpoch !== file.documentEpoch) throw new Error("File changed while opening");

    const pin = this.pool.pin(client, bindingId);
    const identity = Object.freeze({ projectInstanceId: this.options.projectInstanceId, fileId: file.fileId, documentEpoch: file.documentEpoch });
    const ytext = client.doc.getText("content");
    let released = false;
    let version = 0;
    const canWriteListeners = new Set<(value: boolean) => void>();
    const onUpdate = () => { version += 1; };
    client.doc.on("update", onUpdate);
    const isCurrent = () => {
      const catalogFile = this.fileById(identity.fileId);
      return !released && !this.destroyed && !client.isDestroyed && !client.isStopped && !this.readOnly
        && catalogFile?.state === "live" && catalogFile.documentEpoch === identity.documentEpoch;
    };
    const guardWrite = (expectedVersion?: number) => {
      if (!isCurrent()) throw new Error("Sideloaded text binding is no longer writable");
      if (expectedVersion !== undefined && expectedVersion !== version) throw new Error("Sideloaded text binding version is stale");
    };
    const refreshCanWrite = () => { const value = isCurrent(); for (const listener of canWriteListeners) listener(value); };
    this.sideloadedCanWriteRefresh.add(refreshCanWrite);
    const offState = client.subscribeState(refreshCanWrite);
    const binding: SideloadedTextBindingV2 = {
      bindingId, identity, doc: client.doc, ytext,
      get version() { return version; },
      get canWrite() { return isCurrent(); },
      get durabilityState() { return client.durabilityState; },
      subscribeCanWrite(listener) { canWriteListeners.add(listener); listener(isCurrent()); return () => canWriteListeners.delete(listener); },
      subscribeDurability(listener) { if (released) { listener(client.durabilityState); return () => undefined; } return client.subscribeState(listener); },
      applyExternalDocument: (update, expectedVersion) => { guardWrite(expectedVersion); update(client.doc); return version; },
      applyExternalText: (text, expectedVersion) => { guardWrite(expectedVersion); mergeTextIntoYText(ytext, text, EXTERNAL_TEXT_SNAPSHOT_ORIGIN_V2); return version; },
      release: () => {
        if (released) return;
        released = true;
        pin.release();
        offState();
        this.sideloadedCanWriteRefresh.delete(refreshCanWrite);
        client.doc.off("update", onUpdate);
        canWriteListeners.clear();
        this.sideloadedBindings.delete(binding);
      },
    };
    this.sideloadedBindings.add(binding);
    return binding;
  }

  boardDocumentForPath(path: string): StructuredDocumentV2 | null { return this.structuredDocumentForPath(path, "board"); }
  spreadsheetDocumentForPath(path: string): StructuredDocumentV2 | null { return this.structuredDocumentForPath(path, "spreadsheet"); }

  /** A sideloaded board or spreadsheet keeps its own structured Y.Doc when it is shown in the other pane. */
  private structuredDocumentForPath(path: string, kind: "board" | "spreadsheet"): StructuredDocumentV2 | null {
    const file = this.file(path);
    const client = file?.kind === kind && file.state === "live" ? this.clients.get(file.fileId) : undefined;
    if (!client || client.isDestroyed) return null;
    return { doc: client.doc, awareness: client.awareness ?? null, canWrite: !this.readOnly && !client.isStopped };
  }

  /**
   * Keep the document shown in the secondary pane alive and give its editor a
   * path-specific Yjs binding. This deliberately does not activate the file:
   * the primary pane remains the session's awareness/cursor owner.
   */
  async openSecondaryPath(path: string): Promise<{ doc: Y.Doc; provider: { awareness: Awareness }; ytext: Y.Text; undoManager: Y.UndoManager } | null> {
    const generation = ++this.secondaryOpenGeneration;
    const file = this.file(path);
    if (!file || file.kind !== "text" || file.state !== "live") {
      this.releaseSecondaryPath();
      return null;
    }
    const ytext = await this.openPath(path, "secondary", { sideload: true });
    if (generation !== this.secondaryOpenGeneration) return null;
    const client = this.clients.get(file.fileId);
    if (!client || client.isDestroyed) return null;
    if (this.secondaryClient !== client) {
      this.secondaryPin?.release();
      this.secondaryUndoManager?.destroy();
      this.secondaryClient = client;
      this.secondaryUndoManager = new Y.UndoManager(ytext);
      this.secondaryPin = this.pool.pin(client, "secondary");
      this.awarenessVersion += 1;
    }
    this.secondaryPath = path;
    const awareness = client.awareness;
    if (!awareness || !this.secondaryUndoManager) return null;
    return { doc: client.doc, provider: { awareness }, ytext, undoManager: this.secondaryUndoManager };
  }

  releaseSecondaryPath(path?: string): void {
    if (!this.secondaryClient || (path && path !== this.secondaryPath)) return;
    this.secondaryOpenGeneration += 1;
    this.secondaryPin?.release();
    this.secondaryUndoManager?.destroy();
    this.secondaryPin = this.secondaryClient = this.secondaryPath = this.secondaryUndoManager = undefined;
    this.awarenessVersion += 1;
  }

  subscribeSecondaryBindingChanges = (listener: () => void): (() => void) => {
    this.secondaryBindingListeners.add(listener);
    return () => this.secondaryBindingListeners.delete(listener);
  };

  setActivePath(path: string, seedIfEmpty?: string): Y.Text {
    if (path !== this.activePath) throw new Error("v2 files must be awaited with openPath before editor binding");
    if (seedIfEmpty && this.ytext.length === 0) this.ytext.insert(0, seedIfEmpty);
    return this.ytext;
  }

  /** Identity for board cursor presence: same name/color as the avatar list. */
  get boardPresenceUser(): { id: string; name: string; color: string } { return this.presence.boardUser; }

  leavePresence(): Promise<void> { return this.presence.leave(); }

  // --- Catalog operations --------------------------------------------------

  /**
   * Add a file to the shared project mid-session. The server assigns the file
   * identity in `initializing`. Text/board content is durably imported before
   * the coordinator publishes it as live, so peers can never enter an empty
   * room between catalog publication and seeding. Binary files retain the
   * host-ready flow. Read-only actors cannot create.
   */
  async create(path: string, kind: "text" | "binary" | "board" | "spreadsheet", options: { seedText?: string; timeoutMs?: number; adoptExisting?: boolean } = {}): Promise<boolean> {
    this.assertCatalogOnline();
    if (isPaperLibraryPath(path)) throw new Error("paper_library_not_shared");
    if (this.readOnly) throw new Error("Read-only collaborators cannot create files");
    const lease = this.requireLease();
    const existing = this.file(path);
    const occupied = occupiesPath(existing);
    if (occupied && (!options.adoptExisting || existing.kind !== kind)) throw new Error(`File already exists in the v2 catalog: ${path}`);
    this.checkLease(lease);
    const seedText = options.seedText ?? "";
    const seedBytes = new TextEncoder().encode(seedText);
    const initializer = kind === "binary" ? undefined : {
      operationId: `initialize_${crypto.randomUUID()}`,
      size: seedBytes.byteLength,
      hash: await sha256Hex(seedText),
    };
    const diagnostic: DiagnosticOperationContext = { operationId: crypto.randomUUID() };
    const createOp = () => this.operation("create", { path, kind, ...(initializer ? { initializer } : {}) }, diagnostic);
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
      if (occupiesPath(moved)) {
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
    if (createdByThisClient && initializer) {
      const initialize = () => putTextFileV2({
        deployment: this.options.deployment,
        projectInstanceId: this.options.projectInstanceId,
        credential: this.credential,
        fileId: created.fileId,
        documentEpoch: created.documentEpoch,
        bytes: seedBytes,
        hash: initializer.hash,
        operationId: initializer.operationId,
        diagnosticOperation: diagnostic,
      });
      // The import is idempotent per operationId, so one blind retry is safe.
      try { await initialize(); } catch { await initialize(); }
      this.checkLease(lease);
      await this.refetchCatalog();
    }
    const deadline = this.now() + (options.timeoutMs ?? 15_000);
    for (;;) {
      this.checkLease(lease);
      const entry = this.fileById(created.fileId);
      if (!entry) throw new Error("The created file vanished from the catalog");
      if (entry.state === "live") break;
      if (this.now() >= deadline) throw new Error(`Timed out waiting for the host to accept ${path}; it stays local until the host returns`);
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

  async rename(oldPath: string, newPath: string, local: CollabLocalMutationsV2): Promise<string> {
    this.assertCatalogOnline();
    const file = this.file(oldPath);
    if (!file) throw new Error("Unknown catalog path");
    const lease = this.requireLease();
    const { fileId } = file;
    return this.enqueueFile(fileId, async () => {
      this.checkLease(lease);
      this.locallyRenamed.set(fileId, newPath);
      try {
        const result = await this.operation("rename", { fileId, path: newPath });
        this.catalogValue.catalogRevision = result.catalogRevision;
        const renamed = this.file(oldPath);
        if (!renamed) throw new Error("Unknown catalog path");
        renamed.path = newPath;
        this.followRename(renamed.fileId, oldPath, newPath);
        this.checkLease(lease);
        try {
          const actual = await local.rename(oldPath, newPath, lease.projectRoot);
          this.checkLease(lease);
          return actual || newPath;
        } catch (error) {
          await this.refetchCatalog().catch(() => undefined);
          throw error;
        }
      } finally {
        this.locallyRenamed.delete(fileId);
      }
    });
  }

  async delete(path: string, local: CollabLocalMutationsV2): Promise<void> {
    this.assertCatalogOnline();
    const file = this.file(path);
    if (!file) throw new Error("Unknown catalog path");
    const lease = this.requireLease();
    await this.enqueueFile(file.fileId, async () => {
      this.checkLease(lease);
      this.locallyDeleted.add(file.fileId);
      try {
        await this.operation("delete-begin", { fileId: file.fileId });
        await this.refetchCatalog();
        this.diskMirror.detach(file.fileId);
        this.checkLease(lease);
        await local.delete(path, lease.projectRoot);
        this.checkLease(lease);
      } finally {
        this.locallyDeleted.delete(file.fileId);
      }
    });
  }

  async createInvitation(permission: "read" | "write"): Promise<string> {
    this.assertCatalogOnline();
    const guestSecret = randomSecret();
    const salt = randomSecret();
    await this.operation("grants", { permission, guestSecretHash: { salt, hash: await sha256Hex(`${salt}:${guestSecret}`) } });
    await this.refetchCatalog();
    // Keep the original five-field v2 wire shape so older v2 clients continue
    // accepting new invitations. Joiners read the current name from catalog.
    return formatCollabInvitationV2({ version: 2, deployment: new URL(this.options.deployment).origin + "/", projectInstanceId: this.options.projectInstanceId, guestSecret, permission });
  }

  async revoke(grantId: string): Promise<void> {
    this.assertCatalogOnline();
    const result = await this.operation("revoke", { grantId });
    this.catalogValue.catalogRevision = result.catalogRevision;
  }

  async close(): Promise<void> {
    this.assertCatalogOnline();
    if (this.catalogValue.lifecycle === "closing" || this.catalogValue.lifecycle === "closed") return;
    const result = await this.operation("close-begin");
    this.catalogValue.catalogRevision = result.catalogRevision;
    this.catalogValue.lifecycle = result.status === "pending" ? "closing" : "closed";
    this.options.onCatalog?.(this.catalogValue);
  }

  async downloadBinary(path: string): Promise<Uint8Array> {
    const file = this.file(path);
    if (!file || file.kind !== "binary") throw new Error("Unknown binary catalog path");
    return this.getBinaryClient().download(file.fileId, file.documentEpoch);
  }

  async replaceBinary(path: string, bytes: Uint8Array, mime: string, local: CollabLocalMutationsV2): Promise<BinaryReplaceResult> {
    const file = this.file(path);
    if (!file || file.kind !== "binary" || file.state !== "live") throw new Error("Unknown binary catalog path");
    const lease = this.requireLease();
    return this.enqueueFile(file.fileId, async () => {
      this.checkLease(lease);
      const binary = this.getBinaryClient();
      const result = await binary.replace(file.fileId, file.documentEpoch, bytes, mime, this.catalogValue.catalogRevision, file.contentRevision ?? 0, file.hash);
      this.checkLease(lease);
      if (result.status === "conflict") {
        // Someone else's bytes won: keep ours beside the file instead of losing them.
        const loser = await binary.download(file.fileId, file.documentEpoch, result.conflict.conflictId);
        this.checkLease(lease);
        if (!local.writeBinaryConflict) throw new Error("Binary conflict requires an explicit conflict-copy writer");
        await local.writeBinaryConflict(binaryConflictPath(path, result.conflict.conflictId), loser, lease.projectRoot);
        this.report(new Error(`Binary conflict preserved for ${path}`), file.fileId);
      }
      await this.refetchCatalog().catch(() => undefined);
      return result;
    });
  }

  // --- Workspace -----------------------------------------------------------

  /**
   * Attach a workspace lease + disk callbacks without materializing. The host
   * of a share already has the project on disk, so it must not rewrite every
   * file from the server — but it still needs peer tree changes reconciled.
   */
  bindWorkspace(lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2): void {
    this.assertLiveController();
    if (this.workspace && this.workspace.lease !== lease) throw new Error("Controller is already bound to a workspace lease");
    this.workspace = { lease, callbacks };
    this.getBinaryClient(lease);
  }

  async materializeProject(lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2): Promise<CollabMaterializeResultV2> {
    this.assertLiveController();
    this.bindWorkspace(lease, callbacks);
    const files = this.catalogValue.files.filter((file) => file.state === "live" && !isPaperLibraryPath(file.path)).map((file) => ({ ...file }));
    const textFiles = files.filter((file) => file.kind !== "binary");
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        this.checkLease(lease);
        await this.enqueueFile(file.fileId, () => this.pullFile(file, lease, callbacks));
        this.checkLease(lease);
      }
    };
    const concurrency = Math.max(1, Math.min(16, callbacks.concurrency ?? 4, files.length || 1));
    await Promise.all(Array.from({ length: concurrency }, worker));
    const openPath = textFiles.find((file) => /(^|\/)main\.(md|tex|txt)$/i.test(file.path))?.path
      ?? textFiles.find((file) => !file.path.includes("/"))?.path
      ?? textFiles[0]?.path;
    if (!openPath) throw new Error("The shared project has no live text files");
    return { rootPath: lease.projectRoot, openPath, textCount: textFiles.length, binaryCount: files.length - textFiles.length, fileCount: files.length };
  }

  /** Write one live file's current content into the workspace; a text-family file then stays mirrored. */
  private async pullFile(file: CatalogFileV2, lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2, open: OpenPathOptionsV2 = {}): Promise<void> {
    if (file.kind === "binary") {
      const bytes = await this.getBinaryClient().download(file.fileId, file.documentEpoch);
      this.checkLease(lease);
      return callbacks.writeBytes(file.path, bytes, lease.projectRoot);
    }
    // Sideload: pulling files must not steal the editor's active binding (or
    // flap presence across every file it opens).
    const text = await this.openPath(file.path, "secondary", { ...open, sideload: true });
    const client = this.clients.get(file.fileId);
    await client?.settled();
    this.checkLease(lease);
    await callbacks.writeText(file.path, await serializeCollabFileV2(file, text.doc!), lease.projectRoot);
    if (client) this.diskMirror.attach(file, client.doc, lease, callbacks);
  }

  async settled(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.settled()));
  }

  /** Settle every pending workspace write before ending or switching sessions. */
  flush(): Promise<void> { return this.diskMirror.flush(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopEventsPolling();
    this.presence.dispose();
    // Best-effort leave so our entry does not linger until the server TTL.
    if (this.control) void this.presence.leave().catch(() => undefined);
    for (const slot of [this.chat, this.comments]) {
      this.bindPinned(slot, undefined);
      slot.listeners.clear();
      slot.pin?.release();
      slot.pin = undefined;
    }
    for (const binding of [...this.sideloadedBindings]) binding.release();
    this.activePin?.release();
    this.secondaryPin?.release();
    this.secondaryUndoManager?.destroy();
    this.activePin = this.secondaryPin = this.secondaryUndoManager = this.secondaryClient = this.secondaryPath = undefined;
    this.secondaryBindingListeners.clear();
    this.diskMirror.detachAll();
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
    this.canWriteListeners.clear();
    this.undoManager.destroy();
    this.fallbackAwareness.destroy();
    this.fallbackDoc.destroy();
  }

  // --- Internals -----------------------------------------------------------

  private file(path: string): CatalogFileV2 | undefined { return this.catalogValue.files.find((entry) => entry.path === path); }
  private fileById(fileId: string): CatalogFileV2 | undefined { return this.catalogValue.files.find((entry) => entry.fileId === fileId); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private diagnose(name: "join_latency" | "first_file_open", fileId?: string): void {
    const at = this.now();
    this.options.diagnostics?.({ name, at, durationMs: at - this.startedAt, ...(fileId ? { fileId } : {}) });
  }
  private report(error: unknown, fileId?: string): void {
    this.options.onPermanentError?.(error instanceof Error ? error : new Error(String(error)), fileId);
  }
  /** A catalog operation against the revision we last saw; a peer's newer move answers 409. */
  private operation<T = OperationResultV2>(endpoint: string, body: Record<string, unknown> = {}, diagnostic?: DiagnosticOperationContext): Promise<T> {
    return this.control.operation<T>(endpoint, { operationId: crypto.randomUUID(), expectedCatalogRevision: this.catalogValue.catalogRevision, ...body }, diagnostic);
  }
  private async issueTicket(namespace: TextNamespaceV2): Promise<string> {
    const { ticket } = await this.control.operation<{ ticket: string }>("tickets", { audience: "file", fileId: namespace.fileId, documentEpoch: namespace.documentEpoch });
    if (!ticket) throw new Error("Ticket issuer returned no ticket");
    return ticket;
  }
  private checkLease(lease: CollabMaterializeLeaseV2): void {
    this.assertLiveController();
    if (!lease.isCurrent()) throw new Error("Collaboration workspace lease expired");
  }
  private requireLease(): CollabMaterializeLeaseV2 {
    if (!this.workspace) throw new Error("Controller has no workspace lease");
    this.checkLease(this.workspace.lease);
    return this.workspace.lease;
  }
  private getBinaryClient(lease?: CollabMaterializeLeaseV2): CollabBinaryV2Client {
    if (!this.binaryClient) {
      const bound = lease ?? this.requireLease();
      this.binaryClient = new CollabBinaryV2Client(this.options.deployment, this.options.projectInstanceId, this.credential, () => this.checkLease(bound));
    }
    return this.binaryClient;
  }
  /** Tear a client down everywhere it is tracked: disk mirror, client map, and provider pool. */
  private discardClient(fileId: string, client: CollabTextClientV2): void {
    this.diskMirror.detach(fileId);
    if (this.clients.get(fileId) === client) this.clients.delete(fileId);
    this.pool.remove(client);
    client.destroy();
  }
  private onDurability(state: TextDurabilityStateV2): void {
    // Lifecycle states are sticky: a late durable-ack must not flip a closed,
    // offline, importing, or failed project back to "durable".
    if (this.statusValue === "closed" || this.statusValue === "offline" || this.statusValue === "importing" || this.statusValue === "error") return;
    this.setStatus(state === "server-durable" || state === "clean" ? "durable" : "syncing");
  }
  private setStatus(status: CollabProjectStatusV2): void {
    if (this.destroyed || this.statusValue === status) return;
    this.statusValue = status;
    this.options.onStatus?.(status);
  }
  private assertCatalogOnline(): void { if (this.catalogOffline) throw new Error("Collaboration catalog is offline; project changes are unavailable until reconnection"); }
  private assertLiveController(): void { if (this.destroyed) throw new Error("Controller is destroyed"); }
}

function binaryConflictPath(path: string, conflictId: string): string {
  const dot = path.lastIndexOf(".");
  const suffix = `.conflict-${conflictId.slice(0, 8)}`;
  return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
}

function isTransientCatalogFailure(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof CollabControlErrorV2 && (error.status === 408 || error.status === 429 || error.status >= 500));
}
