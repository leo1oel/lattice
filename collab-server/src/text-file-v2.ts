import { type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as decoding from "lib0/decoding";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { parseTextFileV2RoomName, textFileV2RoomName, TEXT_FILE_V2_PARTY, type SocketTicketClaimsV2, type TextFileRoomIdentityV2 } from "../../protocol/collab-v2";
import type { ProjectCoordinatorV2 } from "./project-coordinator-v2";

const IDENTITY_KEY = "text-v2:identity";
const HEAD_KEY = "text-v2:snapshot:head";
const MANIFEST_PREFIX = "text-v2:snapshot:manifest:";
const CHUNK_PREFIX = "text-v2:snapshot:chunk:";
const PENDING_KEY = "text-v2:pending-coordinator";
const CLEANUP_KEY = "text-v2:snapshot:cleanup";
const PINNED_KEY = "text-v2:snapshot:pinned";
const IMPORT_KEY = "text-v2:import";
const AUTHORITY_KEY = "text-v2:authority";
const CHUNK_BYTES = 128_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_UPDATE_BYTES = 512 * 1024;
const MAX_AWARENESS_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_DOCUMENT_BYTES / CHUNK_BYTES);
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
/**
 * Per-connection per-minute ceilings. These must bound a runaway client, not
 * a human: typing produces ~1 update + ~1 awareness frame per keystroke, so
 * fast sustained typing reaches 300-600 of each per minute. Earlier values
 * (240/60/120) disconnected ordinary typists.
 */
export const MAX_FRAMES_PER_MINUTE = 3600;
export const MAX_AWARENESS_PER_MINUTE = 900;
export const MAX_UPDATES_PER_MINUTE = 1800;
/**
 * Successful per-frame coordinator authorizations are cached this long, so a
 * typing burst costs one DO-to-DO call per minute instead of one per update.
 * Real-time revocation does not rely on this cache: the coordinator pushes
 * revokeGrant/fence to this room synchronously (with pending-work retries),
 * and the local authority check runs on every frame regardless.
 */
export const AUTH_CACHE_MS = 60_000;
/** A control-plane outage is tolerated only while a previous authorization is this fresh; anything older still fails closed. */
export const AUTH_OUTAGE_LEEWAY_MS = 5 * 60_000;

export { parseTextFileV2RoomName, textFileV2RoomName, TEXT_FILE_V2_PARTY } from "../../protocol/collab-v2";

type Identity = TextFileRoomIdentityV2 & { fenced?: "deleted" | "closed" };
type Manifest = Identity & { version: 1; generation: number; chunkCount: number; byteLength: number; sha256: string; contentRevision: number };
type Head = { version: 1; current: { generation: number; manifestHash: string }; previous?: { generation: number; manifestHash: string } };
type Authority = { projectAuthorityEpoch: number; revokedGrantEpochs: Record<string, number> };
type ConnectionState = Pick<SocketTicketClaimsV2, "grantId" | "permission" | "grantEpoch" | "projectAuthorityEpoch"> & { windowAt: number; frames: number; updates: number; awareness: number; authorizedAt?: number };
type Pending = { kind: "metadata" | "deleted" | "closed"; identity: Identity; manifest?: Manifest; stateVector?: string; attempts?: number; lastAttemptAt?: number };
type CleanupBacklog = { generations: number[]; attempts: number };
type Env = { ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2> };

export class TextFileV2 extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 2_000, debounceMaxWait: 10_000 };
  private identity!: Identity;
  private authority: Authority = { projectAuthorityEpoch: 0, revokedGrantEpochs: {} };
  private readonly coordinatorEnv: Env;
  private readonly messageTails = new WeakMap<Connection<ConnectionState>, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.coordinatorEnv = env; }

  async onLoad(): Promise<void> {
    const routed = parseTextFileV2RoomName(this.name);
    if (!routed) throw new Error("invalid_room");
    const stored = await this.ctx.storage.get<Identity>(IDENTITY_KEY);
    if (stored && !sameIdentity(stored, routed)) throw new Error("identity_mismatch");
    this.identity = stored ?? routed;
    this.authority = (await this.ctx.storage.get<Authority>(AUTHORITY_KEY)) ?? this.authority;
    if (!stored) await this.ctx.storage.put(IDENTITY_KEY, this.identity);
    const head = await this.ctx.storage.get<Head>(HEAD_KEY);
    if (!head) return;
    for (const candidate of [head.current, head.previous]) {
      if (!candidate) continue;
      try {
        const update = await this.readGeneration(candidate);
        validateUpdate(update);
        applyUpdate(this.document, update);
        return;
      } catch { /* The independently verified previous generation is the only fallback. */ }
    }
    throw new Error("corrupt_snapshot");
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const routed = parseTextFileV2RoomName(this.name);
      const project = request.headers.get("x-lattice-project");
      const file = request.headers.get("x-lattice-file");
      const epoch = Number(request.headers.get("x-lattice-epoch"));
      if (!routed || project !== routed.projectInstanceId || file !== routed.fileId || epoch !== routed.documentEpoch) return typedHttp(409, "stale_epoch");
      const stored = await this.ctx.storage.get<Identity>(IDENTITY_KEY);
      if (stored?.fenced) return typedHttp(410, stored.fenced === "deleted" ? "file_deleted" : "project_closed");
    }
    return super.fetch(request);
  }

  override onConnect(connection: Connection<ConnectionState>, context: ConnectionContext): void | Promise<void> {
    const permission = context.request.headers.get("x-lattice-permission");
    const grantEpoch = Number(context.request.headers.get("x-lattice-grant-epoch"));
    const projectAuthorityEpoch = Number(context.request.headers.get("x-lattice-authority-epoch"));
    if (permission !== "read" && permission !== "write" && permission !== "host") throw new Error("missing_claims");
    if (!Number.isSafeInteger(grantEpoch) || !Number.isSafeInteger(projectAuthorityEpoch)) throw new Error("missing_claims");
    connection.setState({ grantId: context.request.headers.get("x-lattice-grant") ?? "", permission, grantEpoch, projectAuthorityEpoch, windowAt: Date.now(), frames: 0, updates: 0, awareness: 0 });
    return super.onConnect(connection, context);
  }

  override onMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    const prior = this.messageTails.get(connection) ?? Promise.resolve();
    const task = prior.then(() => this.processMessage(connection, message));
    const tail = task.catch(() => undefined);
    this.messageTails.set(connection, tail);
    void tail.finally(() => { if (this.messageTails.get(connection) === tail) this.messageTails.delete(connection); });
    return task;
  }

  private async processMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    const data = toBytes(message);
    if (!data) return close(connection, 4400, "custom_messages_disabled");
    if (data.byteLength > MAX_FRAME_BYTES) return close(connection, 1009, "frame_too_large");
    const state = rateState(connection);
    if (this.identity.fenced || this.authority.projectAuthorityEpoch > state.projectAuthorityEpoch || (this.authority.revokedGrantEpochs[state.grantId] ?? 0) >= state.grantEpoch) return close(connection, 4403, "authority_revoked");
    if (++state.frames > MAX_FRAMES_PER_MINUTE) return close(connection, 4429, "frame_rate_limited");
    let kind: { outer: number; sync?: number };
    try { kind = messageKind(data); } catch { return close(connection, 4400, "invalid_protocol"); }
    if (kind.outer !== 0 && kind.outer !== 1) return close(connection, 4400, "unsupported_message");
    if (kind.outer === 1) {
      if (data.byteLength > MAX_AWARENESS_BYTES) return close(connection, 1009, "awareness_too_large");
      if (++state.awareness > MAX_AWARENESS_PER_MINUTE) return close(connection, 4429, "awareness_rate_limited");
    }
    if (kind.outer === 0 && kind.sync !== 0) {
      if (state.permission === "read") return close(connection, 4403, "read_only_violation");
      if (data.byteLength > MAX_UPDATE_BYTES) return close(connection, 1009, "update_too_large");
      if (++state.updates > MAX_UPDATES_PER_MINUTE) return close(connection, 4429, "update_rate_limited");
      if (encodeStateAsUpdate(this.document).byteLength + data.byteLength > MAX_DOCUMENT_BYTES) return close(connection, 1009, "document_too_large");
      let authorized = state.authorizedAt !== undefined && Date.now() - state.authorizedAt < AUTH_CACHE_MS;
      if (!authorized) {
        let rpcFailed = false;
        try {
          authorized = await this.coordinatorEnv.ProjectCoordinatorV2.getByName(this.identity.projectInstanceId).authorizeTextMessage(
            this.identity.projectInstanceId, this.identity.fileId, this.identity.documentEpoch,
            state.grantId, state.grantEpoch, state.projectAuthorityEpoch,
          );
        } catch { rpcFailed = true; }
        if (rpcFailed) {
          // Control-plane outage: a still-fresh prior authorization keeps the
          // connection writable; anything else fails closed, never fail-open.
          authorized = state.authorizedAt !== undefined && Date.now() - state.authorizedAt < AUTH_OUTAGE_LEEWAY_MS;
        } else if (authorized) {
          state.authorizedAt = Date.now();
        }
        if (!authorized) return close(connection, 4403, "authority_revoked");
      }
      if (this.identity.fenced || this.authority.projectAuthorityEpoch > state.projectAuthorityEpoch || (this.authority.revokedGrantEpochs[state.grantId] ?? 0) >= state.grantEpoch) return close(connection, 4403, "authority_revoked");
    }
    connection.setState(state);
    try { await super.onMessage(connection, message); } catch { close(connection, 4400, "invalid_protocol"); }
  }

  async onSave(): Promise<void> {
    if (this.identity.fenced) return;
    const update = encodeStateAsUpdate(this.document);
    if (update.byteLength > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
    const old = await this.ctx.storage.get<Head>(HEAD_KEY);
    const oldManifest = old ? await this.ctx.storage.get<Manifest>(`${MANIFEST_PREFIX}${old.current.generation}`) : undefined;
    const generation = (oldManifest?.generation ?? 0) + 1;
    const contentRevision = (oldManifest?.contentRevision ?? 0) + 1;
    const chunks: Record<string, Uint8Array> = {};
    for (let offset = 0, index = 0; offset < update.length; offset += CHUNK_BYTES, index++) chunks[`${CHUNK_PREFIX}${generation}:${index}`] = update.slice(offset, offset + CHUNK_BYTES);
    for (const entries of batches(Object.entries(chunks), 128)) await this.ctx.storage.put(Object.fromEntries(entries));
    const manifest: Manifest = { ...this.identity, version: 1, generation, chunkCount: Object.keys(chunks).length, byteLength: update.byteLength, sha256: await sha256(update), contentRevision };
    const manifestHash = await hashJson(manifest);
    await this.ctx.storage.put(`${MANIFEST_PREFIX}${generation}`, manifest);
    await this.ctx.storage.put(HEAD_KEY, { version: 1, current: { generation, manifestHash }, ...(old?.current ? { previous: old.current } : {}) } satisfies Head);
    await this.enqueueObsoleteGenerations(generation, old?.current.generation);
    const stateVector = base64UrlBytes(encodeStateVector(this.document));
    const pending: Pending = { kind: "metadata", identity: this.identity, manifest, stateVector };
    await this.ctx.storage.put(PENDING_KEY, pending);
    await this.deliverPending(pending);
    this.broadcastCustomMessage(JSON.stringify({ type: "lattice.durable-ack", protocol: 2, projectInstanceId: this.identity.projectInstanceId, fileId: this.identity.fileId, documentEpoch: this.identity.documentEpoch, contentRevision, snapshotGeneration: generation, stateVector, size: manifest.byteLength, hash: manifest.sha256 }));
  }

  /** Trusted initialization seam used only after Coordinator manifest authorization. */
  async initializeImport(projectInstanceId: string, fileId: string, documentEpoch: number, operationId: string, bytes: Uint8Array, declaredHash: string): Promise<"created" | "replayed"> {
    const routed = parseTextFileV2RoomName(this.name);
    if (!routed || !sameIdentity(routed, { protocol: 2, projectInstanceId, fileId, documentEpoch })) throw new Error("identity_mismatch");
    const prior = await this.ctx.storage.get<{ operationId: string; hash: string }>(IMPORT_KEY);
    if (prior) {
      if (prior.operationId === operationId && prior.hash === declaredHash) return "replayed";
      throw new Error("already_initialized");
    }
    if (await this.ctx.storage.get(HEAD_KEY)) throw new Error("already_initialized");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error("invalid_utf8"); }
    this.identity = routed;
    await this.ctx.storage.put(IDENTITY_KEY, routed);
    this.document.getText("content").insert(0, text);
    await this.onSave();
    await this.ctx.storage.put(IMPORT_KEY, { operationId, hash: declaredHash });
    return "created";
  }

  async revokeGrant(grantId: string, grantEpoch: number, authorityEpoch: number): Promise<boolean> {
    if (!grantId || !Number.isSafeInteger(grantEpoch) || !Number.isSafeInteger(authorityEpoch)) return false;
    const routed = parseTextFileV2RoomName(this.name);
    if (!routed) return false;
    this.identity = (await this.ctx.storage.get<Identity>(IDENTITY_KEY)) ?? routed;
    this.authority = (await this.ctx.storage.get<Authority>(AUTHORITY_KEY)) ?? this.authority;
    this.authority.revokedGrantEpochs[grantId] = Math.max(this.authority.revokedGrantEpochs[grantId] ?? 0, grantEpoch);
    this.authority.projectAuthorityEpoch = Math.max(this.authority.projectAuthorityEpoch, authorityEpoch);
    await this.ctx.storage.put(AUTHORITY_KEY, this.authority);
    for (const connection of this.getConnections<ConnectionState>()) if (connection.state?.grantId === grantId && connection.state.grantEpoch <= grantEpoch) connection.close(4403, "authority_revoked");
    console.info(JSON.stringify({ event: "text_grant_revoked", projectInstanceId: this.identity.projectInstanceId, fileId: this.identity.fileId, grantId, grantEpoch, authorityEpoch }));
    return true;
  }

  /** Trusted migration/recovery seam. Pins are explicit and survive eviction. */
  async setGenerationPinned(generation: number, pinned: boolean): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_generation");
    const pins = new Set((await this.ctx.storage.get<number[]>(PINNED_KEY)) ?? []);
    if (pinned) pins.add(generation); else pins.delete(generation);
    await this.ctx.storage.put(PINNED_KEY, [...pins].sort((a, b) => a - b));
    if (!pinned) {
      const head = await this.ctx.storage.get<Head>(HEAD_KEY);
      if (head) await this.enqueueObsoleteGenerations(head.current.generation, head.previous?.generation);
    }
  }

  async fenceForDeletion(projectInstanceId: string, fileId: string, documentEpoch: number, authorityEpoch = 0): Promise<boolean> { return this.fence("deleted", projectInstanceId, fileId, documentEpoch, authorityEpoch); }
  async fenceForProjectClose(projectInstanceId: string, fileId: string, documentEpoch: number, authorityEpoch = 0): Promise<boolean> { return this.fence("closed", projectInstanceId, fileId, documentEpoch, authorityEpoch); }

  /** Idle-project expiry seam: the coordinator wipes every file DO before reclaiming itself. Idempotent. */
  async destroyForExpiry(projectInstanceId: string, fileId: string, documentEpoch: number): Promise<boolean> {
    const routed = parseTextFileV2RoomName(this.name);
    if (!routed || !sameIdentity(routed, { protocol: 2, projectInstanceId, fileId, documentEpoch })) return false;
    for (const connection of this.getConnections()) connection.close(4411, "project_closed");
    await this.ctx.storage.deleteAll();
    return true;
  }

  private async fence(kind: "deleted" | "closed", project: string, file: string, epoch: number, authorityEpoch: number): Promise<boolean> {
    const routed = parseTextFileV2RoomName(this.name);
    if (!routed || !sameIdentity(routed, { protocol: 2, projectInstanceId: project, fileId: file, documentEpoch: epoch })) return false;
    this.identity = (await this.ctx.storage.get<Identity>(IDENTITY_KEY)) ?? routed;
    if (!this.identity.fenced) {
      this.identity = { ...this.identity, fenced: kind };
      this.authority.projectAuthorityEpoch = Math.max(this.authority.projectAuthorityEpoch, authorityEpoch);
      await this.ctx.storage.put({ [IDENTITY_KEY]: this.identity, [AUTHORITY_KEY]: this.authority });
    }
    for (const connection of this.getConnections()) connection.close(kind === "deleted" ? 4410 : 4411, kind === "deleted" ? "file_deleted" : "project_closed");
    if (kind === "deleted") {
      // Enqueue the deletion acknowledgement regardless of whether the fence
      // transitioned just now: a crash between the identity write and a repeat
      // fence must not strand the content. The coordinator only accepts the
      // ack once the file is tombstoned, and the alarm delivery wipes the
      // content after that acceptance.
      const pending: Pending = { kind: "deleted", identity: this.identity };
      await this.ctx.storage.put(PENDING_KEY, pending);
      await this.ctx.storage.setAlarm(Date.now() + 1);
    }
    console.info(JSON.stringify({ event: "text_file_fenced", projectInstanceId: project, fileId: file, documentEpoch: epoch, kind, authorityEpoch }));
    return true;
  }

  override async onAlarm(): Promise<void> {
    const pending = await this.ctx.storage.get<Pending>(PENDING_KEY);
    if (pending) await this.deliverPending(pending);
    await this.drainCleanup();
  }

  private async enqueueObsoleteGenerations(current: number, previous?: number): Promise<void> {
    const pins = new Set((await this.ctx.storage.get<number[]>(PINNED_KEY)) ?? []);
    const existing = (await this.ctx.storage.get<CleanupBacklog>(CLEANUP_KEY)) ?? { generations: [], attempts: 0 };
    const manifests = await this.ctx.storage.list<Manifest>({ prefix: MANIFEST_PREFIX });
    const obsolete = [...manifests.values()].map(item => item.generation)
      .filter(item => item !== current && item !== previous && !pins.has(item));
    const generations = [...new Set([...existing.generations, ...obsolete])].sort((a, b) => a - b);
    if (!generations.length) return;
    await this.ctx.storage.put(CLEANUP_KEY, { generations, attempts: existing.attempts });
    console.info(JSON.stringify({ event: "text_snapshot_cleanup_backlog", projectInstanceId: this.identity.projectInstanceId, fileId: this.identity.fileId, generations: generations.length }));
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  private async drainCleanup(): Promise<void> {
    const backlog = await this.ctx.storage.get<CleanupBacklog>(CLEANUP_KEY);
    if (!backlog?.generations.length) return;
    const head = await this.ctx.storage.get<Head>(HEAD_KEY);
    const pins = new Set((await this.ctx.storage.get<number[]>(PINNED_KEY)) ?? []);
    const generation = backlog.generations[0];
    if (generation === head?.current.generation || generation === head?.previous?.generation || pins.has(generation)) {
      backlog.generations.shift(); backlog.attempts = 0;
    } else {
      try {
        const manifest = await this.ctx.storage.get<Manifest>(`${MANIFEST_PREFIX}${generation}`);
        const keys = Array.from({ length: manifest?.chunkCount ?? MAX_CHUNKS }, (_, i) => `${CHUNK_PREFIX}${generation}:${i}`);
        for (const batch of batches(keys, 128)) await this.deleteSnapshotKeys(batch);
        await this.deleteSnapshotKeys(`${MANIFEST_PREFIX}${generation}`);
        backlog.generations.shift(); backlog.attempts = 0;
      } catch {
        backlog.attempts++;
      }
    }
    if (backlog.generations.length) {
      await this.ctx.storage.put(CLEANUP_KEY, backlog);
      const delay = backlog.attempts ? retryDelay(backlog.attempts) : 1;
      await this.ctx.storage.setAlarm(Date.now() + delay);
    } else await this.ctx.storage.delete(CLEANUP_KEY);
  }

  /** Production cleanup seam: tests may inject transient storage-delete failures. */
  async deleteSnapshotKeys(keys: string | string[]): Promise<void> {
    if (typeof keys === "string") await this.ctx.storage.delete(keys);
    else await this.ctx.storage.delete(keys);
  }

  private async deliverPending(pending: Pending): Promise<void> {
    const attempted: Pending = { ...pending, attempts: (pending.attempts ?? 0) + 1, lastAttemptAt: Date.now() };
    await this.ctx.storage.put(PENDING_KEY, attempted);
    try {
      const stub = this.coordinatorEnv.ProjectCoordinatorV2.getByName(pending.identity.projectInstanceId);
      let accepted = false;
      if (pending.kind === "metadata") accepted = await stub.updateTextDurableMetadata(pending.identity.fileId, pending.identity.documentEpoch, pending.manifest!.contentRevision, pending.manifest!.generation, pending.manifest!.byteLength, pending.manifest!.sha256, pending.stateVector!);
      else if (pending.kind === "deleted") accepted = await stub.acknowledgeFileDeleted(pending.identity.fileId, pending.identity.documentEpoch);
      else accepted = await stub.acknowledgeFileClosed(pending.identity.fileId, pending.identity.documentEpoch);
      if (accepted) {
        await this.ctx.storage.delete(PENDING_KEY);
        // The coordinator now owns the deletion record, so the content is
        // unreachable. Keep only the fenced identity tombstone: stale tickets
        // must still meet a 410 instead of a reborn empty document.
        if (pending.kind === "deleted") await this.wipeContentAfterDeletion();
      } else await this.schedulePendingRetry(attempted);
    } catch { await this.schedulePendingRetry(attempted); }
  }

  private async wipeContentAfterDeletion(): Promise<void> {
    let startAfter: string | undefined;
    while (true) {
      const page = await this.ctx.storage.list({ limit: 128, ...(startAfter ? { startAfter } : {}) });
      if (!page.size) break;
      const keys = [...page.keys()].filter((key) => key !== IDENTITY_KEY && key !== AUTHORITY_KEY);
      startAfter = [...page.keys()].at(-1);
      if (keys.length) await this.ctx.storage.delete(keys);
      if (page.size < 128) break;
    }
  }

  private async schedulePendingRetry(pending: Pending): Promise<void> {
    const delay = retryDelay(pending.attempts ?? 1);
    console.warn(JSON.stringify({ event: "text_file_callback_backlog", projectInstanceId: pending.identity.projectInstanceId, fileId: pending.identity.fileId, documentEpoch: pending.identity.documentEpoch, kind: pending.kind, attempts: pending.attempts, retryInMs: delay }));
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async readGeneration(candidate: { generation: number; manifestHash: string }): Promise<Uint8Array> {
    const manifest = await this.ctx.storage.get<Manifest>(`${MANIFEST_PREFIX}${candidate.generation}`);
    if (!validManifest(manifest, candidate, this.identity) || await hashJson(manifest) !== candidate.manifestHash) throw new Error("manifest_invalid");
    const parts: Uint8Array[] = [];
    for (let i = 0; i < manifest.chunkCount; i++) { const part = await this.ctx.storage.get<Uint8Array>(`${CHUNK_PREFIX}${candidate.generation}:${i}`); if (!(part instanceof Uint8Array)) throw new Error("missing_chunk"); parts.push(part); }
    const update = concat(parts); if (update.byteLength !== manifest.byteLength || await sha256(update) !== manifest.sha256) throw new Error("snapshot_invalid"); return update;
  }
}

function messageKind(data: Uint8Array): { outer: number; sync?: number } { const decoder = decoding.createDecoder(data); const outer = decoding.readVarUint(decoder); return { outer, ...(outer === 0 ? { sync: decoding.readVarUint(decoder) } : {}) }; }
function validManifest(manifest: Manifest | undefined, candidate: { generation: number; manifestHash: string }, identity: Identity): manifest is Manifest {
  return !!manifest && manifest.version === 1 && sameIdentity(manifest, identity)
    && Number.isSafeInteger(manifest.documentEpoch) && manifest.documentEpoch > 0
    && Number.isSafeInteger(manifest.generation) && manifest.generation > 0 && manifest.generation === candidate.generation
    && Number.isSafeInteger(manifest.contentRevision) && manifest.contentRevision > 0
    && Number.isSafeInteger(manifest.chunkCount) && manifest.chunkCount > 0 && manifest.chunkCount <= MAX_CHUNKS
    && Number.isSafeInteger(manifest.byteLength) && manifest.byteLength > 0 && manifest.byteLength <= MAX_DOCUMENT_BYTES
    && manifest.chunkCount === Math.ceil(manifest.byteLength / CHUNK_BYTES)
    && typeof manifest.sha256 === "string" && /^[a-f0-9]{64}$/.test(manifest.sha256)
    && typeof candidate.manifestHash === "string" && /^[a-f0-9]{64}$/.test(candidate.manifestHash);
}
function retryDelay(attempts: number): number { return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(8, Math.max(0, attempts - 1)))); }
function rateState(connection: Connection<ConnectionState>): ConnectionState { const state = connection.state; if (!state) throw new Error("missing_claims"); if (Date.now() - state.windowAt >= 60_000) return { ...state, windowAt: Date.now(), frames: 0, updates: 0, awareness: 0 }; return { ...state }; }
function close(connection: Connection, code: number, reason: string): void { connection.close(code, reason); }
function toBytes(message: WSMessage): Uint8Array | null { if (typeof message === "string") return null; return message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength); }
function base64UrlBytes(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function sameIdentity(a: Identity, b: Identity): boolean { return a.protocol === 2 && a.projectInstanceId === b.projectInstanceId && a.fileId === b.fileId && a.documentEpoch === b.documentEpoch; }
async function sha256(value: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function hashJson(value: object): Promise<string> { return sha256(new TextEncoder().encode(JSON.stringify(value))); }
function validateUpdate(update: Uint8Array): void { const probe = new Doc(); try { applyUpdate(probe, update); encodeStateAsUpdate(probe); } finally { probe.destroy(); } }
function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
function batches<T>(items: T[], size: number): T[][] { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }
function typedHttp(status: number, error: string): Response { return new Response(JSON.stringify({ protocol: 2, error }), { status, headers: { "content-type": "application/json" } }); }
