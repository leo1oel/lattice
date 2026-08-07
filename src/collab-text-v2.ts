import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import YProvider from "y-partyserver/provider";
import { isDurableAckV2, textFileV2RoomName, TEXT_FILE_V2_PARTY, type DurableAckV2 } from "../protocol/collab-v2";
import { CollabTextDurableStoreV2, textNamespaceKey, type OutboxEntryV2, type TextNamespaceV2, updateCoveredByStateVector } from "./collab-text-v2-store";

const RESTORE_ORIGIN = Symbol("v2-restore"), REMOTE_ORIGIN = Symbol("v2-remote"), SEND_ORIGIN = Symbol("v2-send");
export type TextClientPermanentCodeV2 = "revoked" | "stale_epoch" | "file_deleted" | "project_closed" | "tombstoned" | "connection_failed";
export class TextClientPermanentErrorV2 extends Error { constructor(readonly code: TextClientPermanentCodeV2, options?: ErrorOptions) { super(code, options); } }
/**
 * The client was torn down while something was still awaiting it — closing a
 * file, switching documents, ending a share. That is the normal end of a
 * client's life, not a failure, so callers surface it as nothing at all rather
 * than as "Client is destroyed" on screen. A distinct type keeps that decision
 * off string matching.
 */
export class ClientDestroyedErrorV2 extends Error { constructor() { super("Client is destroyed"); } }
export function isClientDestroyedErrorV2(reason: unknown): boolean { return reason instanceof ClientDestroyedErrorV2; }
export type TextDurabilityStateV2 = "temporary" | "transport-synced" | "server-durable" | "clean";
export type TextTransportV2 = { awareness?: Awareness; onCustomMessage(listener: (message: unknown) => void): () => void; onDisconnect(listener: (error?: unknown) => void): () => void; onSynced(listener: (synced: boolean) => void): () => void; clearAwareness(): void; destroy(): void };
export type TextTransportFactoryV2 = (args: { namespace: TextNamespaceV2; doc: Y.Doc; ticket: string }) => TextTransportV2;
export type TicketIssuerV2 = (namespace: TextNamespaceV2) => Promise<string>;
export type ReconnectPolicyV2 = { schedule(task: () => void, delayMs: number): unknown; cancel(handle: unknown): void; delay(attempt: number): number };
export function reconnectDelayV2(attempt: number, random = Math.random): number { return Math.min(2_500, 100 * 2 ** Math.min(attempt, 5) * (0.75 + random() * 0.5)); }
const defaultReconnect: ReconnectPolicyV2 = { schedule: (task, ms) => setTimeout(task, ms), cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), delay: reconnectDelayV2 };

export class CollabTextClientV2 {
  readonly doc = new Y.Doc();
  private networkDoc?: Y.Doc; private transport?: TextTransportV2; private unbind: (() => void)[] = []; private outbox: OutboxEntryV2[] = [];
  private revision = -1; private generation = -1; private stopped?: TextClientPermanentErrorV2; private tail: Promise<void> = Promise.resolve(); private lastUsed = Date.now();
  private connectionGeneration = 0; private reconnectAttempt = 0; private reconnectHandle?: unknown; private destroyed = false; private durableSeen = false; private providerSynced = false; private disposing = false;
  private connecting?: Promise<void>;
  private stateListeners = new Set<(state: TextDurabilityStateV2) => void>();
  /** Fired whenever the transport (and thus its Awareness) is replaced or torn down — reconnects make the old awareness a dead object. */
  private transportListeners = new Set<() => void>();
  private syncWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private constructor(readonly namespace: TextNamespaceV2, private readonly store: CollabTextDurableStoreV2, private readonly issueTicket: TicketIssuerV2, private readonly factory: TextTransportFactoryV2, private readonly reconnectPolicy: ReconnectPolicyV2) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin === RESTORE_ORIGIN) return; this.enqueue(origin === REMOTE_ORIGIN ? () => this.store.persistSnapshot(this.namespace, this.doc) : () => this.persistThenPublish(update)); });
  }
  static async open(namespace: TextNamespaceV2, options: { store: CollabTextDurableStoreV2; issueTicket: TicketIssuerV2; transportFactory: TextTransportFactoryV2; reconnect?: ReconnectPolicyV2 }): Promise<CollabTextClientV2> {
    const client = new CollabTextClientV2(namespace, options.store, options.issueTicket, options.transportFactory, options.reconnect ?? defaultReconnect); const saved = await options.store.load(namespace);
    if (saved) { Y.applyUpdate(client.doc, saved.snapshot, RESTORE_ORIGIN); for (const entry of saved.outbox) Y.applyUpdate(client.doc, entry.update, RESTORE_ORIGIN); client.outbox = saved.outbox;
      if (saved.ack && client.validAck(saved.ack)) { const vector = safeDecodeBase64Url(saved.ack.stateVector); if (vector) { client.revision = saved.ack.contentRevision; client.generation = saved.ack.snapshotGeneration; client.durableSeen = true; client.outbox = await options.store.deleteCovered(namespace, vector); } }
    } return client;
  }
  connect(): Promise<void> { if (this.destroyed) return Promise.reject(new ClientDestroyedErrorV2()); if (this.stopped) return Promise.reject(this.stopped); if (this.transport) return Promise.resolve(); if (this.connecting) return this.connecting;
    const connecting = this.connectFresh(); this.connecting = connecting; void connecting.finally(() => { if (this.connecting === connecting) this.connecting = undefined; }).catch(() => undefined); return connecting;
  }
  private async connectFresh(): Promise<void> { this.cancelReconnect(); const generation = ++this.connectionGeneration; this.disposeTransport();
    try { const ticket = await this.issueTicket(this.namespace); if (generation !== this.connectionGeneration || this.destroyed) throw this.destroyed ? new ClientDestroyedErrorV2() : new Error("Connection was superseded"); const networkDoc = new Y.Doc(); this.networkDoc = networkDoc;
      networkDoc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== SEND_ORIGIN) Y.applyUpdate(this.doc, update, REMOTE_ORIGIN); });
      const transport = this.factory({ namespace: this.namespace, doc: networkDoc, ticket }); if (generation !== this.connectionGeneration || this.destroyed) { transport.destroy(); networkDoc.destroy(); throw this.destroyed ? new ClientDestroyedErrorV2() : new Error("Connection was superseded"); }
      this.transport = transport; this.unbind = [transport.onCustomMessage((message) => { const checkpoint = Y.encodeStateAsUpdate(this.doc); this.enqueue(() => this.handleCustomMessage(message, checkpoint)); }), transport.onDisconnect((e) => this.onDisconnect(generation, e)), transport.onSynced((synced) => { if (generation === this.connectionGeneration && !this.destroyed) { this.providerSynced = synced; if (synced) { this.reconnectAttempt = 0; this.resolveSyncWaiters(); } this.emitState(); } })];
      for (const entry of this.outbox) Y.applyUpdate(networkDoc, entry.update, SEND_ORIGIN); this.emitTransport(); this.emitState();
    } catch (cause) { if (generation === this.connectionGeneration && !this.destroyed) { if (cause instanceof TextClientPermanentErrorV2) this.stopped = cause; else this.scheduleReconnect(generation); this.emitState(); } throw cause; }
  }
  async settled(): Promise<void> { await this.tail; }
  touch(at = Date.now()): void { this.lastUsed = at; }
  get lastAccessed(): number { return this.lastUsed; }
  get hasOutbox(): boolean { return this.outbox.length > 0; }
  get isStopped(): boolean { return !!this.stopped; }
  get isDestroyed(): boolean { return this.destroyed; }
  get awareness(): Awareness | undefined { return this.transport?.awareness; }
  get synced(): boolean { return this.providerSynced; }
  /** True when this device has previously reached server-durable state for the doc — i.e. the restored snapshot is a server-acked baseline, not a blank or purely local draft. Gates cached-first opens. */
  get hasSyncedSnapshot(): boolean { return this.durableSeen; }
  waitForSynced(timeoutMs = 20_000): Promise<void> { if (this.providerSynced) return Promise.resolve(); if (this.destroyed) return Promise.reject(new ClientDestroyedErrorV2()); return new Promise((resolve, reject) => { const waiter = { resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined }; waiter.timer = setTimeout(() => { this.syncWaiters.delete(waiter); reject(new Error("Timed out waiting for file sync")); }, timeoutMs); this.syncWaiters.add(waiter); }); }
  get durabilityState(): TextDurabilityStateV2 { return this.outbox.length ? (this.durableSeen ? "server-durable" : (this.providerSynced ? "transport-synced" : "temporary")) : (this.durableSeen ? "clean" : "temporary"); }
  subscribeTransport(listener: () => void): () => void { this.transportListeners.add(listener); return () => this.transportListeners.delete(listener); }
  subscribeState(listener: (state: TextDurabilityStateV2) => void): () => void { this.stateListeners.add(listener); listener(this.durabilityState); return () => this.stateListeners.delete(listener); }
  async exportRecovery() { return this.store.export(this.namespace); }
  async recoverAsNewFile(namespace: TextNamespaceV2): Promise<Uint8Array> { if (namespace.deployment !== this.namespace.deployment || namespace.projectInstanceId !== this.namespace.projectInstanceId || namespace.fileId === this.namespace.fileId || !Number.isSafeInteger(namespace.documentEpoch) || namespace.documentEpoch <= 0) throw new Error("Recovery requires a Coordinator-authorized new file identity"); return Y.encodeStateAsUpdate(this.doc); }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; ++this.connectionGeneration; this.cancelReconnect(); this.disposeTransport(); for (const waiter of this.syncWaiters) { if (waiter.timer) clearTimeout(waiter.timer); waiter.reject(new ClientDestroyedErrorV2()); } this.syncWaiters.clear(); this.doc.destroy(); this.stateListeners.clear(); this.transportListeners.clear(); }
  private enqueue(action: () => Promise<void>): void { this.tail = this.tail.then(action, action); }
  private async persistThenPublish(update: Uint8Array): Promise<void> { const entry = { id: await hash(update), update, createdAt: Date.now() }; await this.store.persistLocal(this.namespace, this.doc, entry); if (!this.outbox.some((x) => x.id === entry.id)) this.outbox.push(entry); if (this.networkDoc) Y.applyUpdate(this.networkDoc, update, SEND_ORIGIN); this.emitState(); }
  private async handleCustomMessage(raw: unknown, checkpoint: Uint8Array): Promise<void> { let value = raw; if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { return; } } if (!isDurableAckV2(value) || !this.validAck(value)) return; const ack = value as DurableAckV2; const vector = safeDecodeBase64Url(ack.stateVector); if (!vector) return;
    if (ack.contentRevision < this.revision || ack.snapshotGeneration < this.generation || ((ack.contentRevision === this.revision) !== (ack.snapshotGeneration === this.generation))) return;
    const covered = this.outbox.filter((entry) => updateCoveredByStateVector(entry.update, vector)); if (!covered.length && this.outbox.length) return;
    this.outbox = await this.store.compactAck(this.namespace, checkpoint, ack, vector); this.revision = ack.contentRevision; this.generation = ack.snapshotGeneration; this.durableSeen = true; this.emitState();
  }
  private validAck(ack: DurableAckV2): boolean { return isDurableAckV2(ack) && ack.projectInstanceId === this.namespace.projectInstanceId && ack.fileId === this.namespace.fileId && ack.documentEpoch === this.namespace.documentEpoch; }
  private onDisconnect(generation: number, error?: unknown): void { if (generation !== this.connectionGeneration || this.destroyed) return; if (error instanceof TextClientPermanentErrorV2) { this.stopped = error; ++this.connectionGeneration; this.disposeTransport(); this.emitState(); return; }
    this.disposeTransport(); this.scheduleReconnect(generation); this.emitState();
  }
  private scheduleReconnect(generation: number): void { if (this.reconnectHandle !== undefined) return; const delay = this.reconnectPolicy.delay(this.reconnectAttempt++); this.reconnectHandle = this.reconnectPolicy.schedule(() => { this.reconnectHandle = undefined; if (generation !== this.connectionGeneration || this.destroyed || this.stopped) return; void this.connect().catch(() => undefined); }, delay); }
  private cancelReconnect(): void { if (this.reconnectHandle !== undefined) this.reconnectPolicy.cancel(this.reconnectHandle); this.reconnectHandle = undefined; }
  private disposeTransport(): void { if (this.disposing) return; this.disposing = true; this.providerSynced = false; for (const off of this.unbind.splice(0)) off(); const transport = this.transport; const networkDoc = this.networkDoc; this.transport = undefined; this.networkDoc = undefined; transport?.clearAwareness(); transport?.destroy(); networkDoc?.destroy(); this.disposing = false; if (transport) this.emitTransport(); }
  private emitTransport(): void { for (const listener of this.transportListeners) listener(); }
  private emitState(): void { for (const listener of this.stateListeners) listener(this.durabilityState); }
  private resolveSyncWaiters(): void { for (const waiter of this.syncWaiters) { if (waiter.timer) clearTimeout(waiter.timer); waiter.resolve(); } this.syncWaiters.clear(); }
}

export function closeEventErrorV2(event: { code?: number; reason?: string }): Error | TextClientPermanentErrorV2 | undefined { const code = event.code ?? 1006; const reason = event.reason ?? ""; const mapped = reason.match(/revoked/) ? "revoked" : reason.match(/stale/) ? "stale_epoch" : reason.match(/tombstone|file_deleted/) ? "file_deleted" : reason.match(/project_closed/) ? "project_closed" : undefined; if (mapped) return new TextClientPermanentErrorV2(mapped); if ([4401, 4403, 4410, 4411].includes(code) || code === 1008) return new TextClientPermanentErrorV2(code === 4410 ? "file_deleted" : code === 4411 ? "project_closed" : "revoked"); return code === 1000 ? undefined : new Error(`WebSocket closed (${code}${reason ? `: ${reason}` : ""})`); }
export function ticketHttpErrorV2(status: number, error?: string): Error | TextClientPermanentErrorV2 { const code = error === "stale_epoch" || status === 409 ? "stale_epoch" : error === "file_deleted" || error === "tombstoned" || status === 410 ? "file_deleted" : error === "project_closed" ? "project_closed" : status === 401 || status === 403 || error === "revoked" ? "revoked" : undefined; return code ? new TextClientPermanentErrorV2(code) : new Error(`Ticket request failed (${status}${error ? `: ${error}` : ""})`); }
export function createYPartyTransportV2(options: { host: string }): TextTransportFactoryV2 { return ({ namespace, doc, ticket }) => { const room = textFileV2RoomName(namespace.projectInstanceId, namespace.fileId, namespace.documentEpoch); const provider = new YProvider(options.host, room, doc, { party: TEXT_FILE_V2_PARTY, params: { ticket }, disableBc: true }); return {
  awareness: provider.awareness,
  onCustomMessage(listener) { provider.on("custom-message", listener); return () => provider.off("custom-message", listener); },
  onDisconnect(listener) { const wrapped = (event: unknown) => listener(closeEventErrorV2(event && typeof event === "object" ? event as { code?: number; reason?: string } : {})); provider.on("connection-close", wrapped); return () => provider.off("connection-close", wrapped); },
  onSynced(listener) { provider.on("synced", listener); return () => provider.off("synced", listener); },
  clearAwareness() { provider.awareness.setLocalState(null); }, destroy() { provider.destroy(); },
}; }; }

export class CollabTextProviderPoolV2 {
  private entries = new Map<string, { client: CollabTextClientV2; pins: Set<string>; draft: boolean; off: () => void }>();
  constructor(private readonly capacity: number, private readonly clock: () => number = Date.now) { if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer"); }
  add(client: CollabTextClientV2): void { const key = textNamespaceKey(client.namespace); const old = this.entries.get(key); if (old) { old.off(); old.client.destroy(); } const entry: { client: CollabTextClientV2; pins: Set<string>; draft: boolean; off: () => void } = { client, pins: new Set<string>(), draft: false, off: () => undefined }; this.entries.set(key, entry); entry.off = client.subscribeState(() => this.evict()); client.touch(this.clock()); this.evict(); }
  remove(client: CollabTextClientV2): void { const key = textNamespaceKey(client.namespace); const entry = this.entries.get(key); if (!entry || entry.client !== client) return; entry.off(); this.entries.delete(key); }
  pin(client: CollabTextClientV2, reason: "main" | "secondary" | "chat" | "comments"): void { this.entry(client).pins.add(reason); client.touch(this.clock()); }
  unpin(client: CollabTextClientV2, reason: "main" | "secondary" | "chat" | "comments"): void { this.entry(client).pins.delete(reason); this.evict(); }
  setDraft(client: CollabTextClientV2, draft: boolean): void { this.entry(client).draft = draft; this.evict(); }
  rename(client: CollabTextClientV2, _path: string): CollabTextClientV2 { client.touch(); return client; }
  get size(): number { return this.entries.size; }
  private entry(client: CollabTextClientV2) { const entry = this.entries.get(textNamespaceKey(client.namespace)); if (!entry || entry.client !== client) throw new Error("Client is not pooled"); return entry; }
  private evict(): void { while (this.entries.size > this.capacity) { const candidates = [...this.entries.entries()].filter(([, e]) => !e.pins.size && !e.draft && e.client.durabilityState === "clean").sort((a, b) => a[1].client.lastAccessed - b[1].client.lastAccessed); const victim = candidates[0]; if (!victim) return; victim[1].off(); victim[1].client.destroy(); this.entries.delete(victim[0]); } }
}
function safeDecodeBase64Url(value: string): Uint8Array | undefined { try { const base64 = value.replaceAll("-", "+").replaceAll("_", "/"); const bytes = Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (char) => char.charCodeAt(0)); Y.decodeStateVector(bytes); return bytes; } catch { return undefined; } }
function hash(value: Uint8Array): Promise<string> { return crypto.subtle.digest("SHA-256", value).then((bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")); }
