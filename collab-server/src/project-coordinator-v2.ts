import {
  BINARY_OBJECT_VERSION,
  CONTROL_PROTOCOL_VERSION,
  isBinaryContentType,
  isBinarySize,
  isOperationId,
  isSha256,
  type BinaryConflictV2,
  type BinaryReadTicketClaimsV2,
  type BinaryReferenceV2,
  type BinaryUploadTicketClaimsV2,
  type CatalogFileV2,
  type CatalogV2,
  type CoordinatorEventV2,
  type GrantPermission,
  type OperationResultV2,
  type SocketTicketClaimsV2,
} from "../../protocol/collab-v2";
import { DurableObject } from "cloudflare:workers";
import { textFileV2RoomName, type TextFileV2 } from "./text-file-v2";

const STATE_KEY = "coordinator:v2";
const MAX_FILES = 2_000;
const MAX_PATH = 512;
const MAX_PROJECT_NAME = 80;
const MAX_GRANTS = 100;
const MAX_EVENTS = 256;
const MAX_OPERATIONS = 512;
const MAX_TICKETS_PER_MINUTE = 120;
const TICKET_TTL_MS = 60_000;
const MIN_GC_GRACE_MS = 60 * 60_000;
const MAX_RETENTION_TTL_MS = 90 * 24 * 60 * 60_000;
/** Idle projects are fully reclaimed after this, matching the v1 room TTL. */
export const PROJECT_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Activity is rewritten to storage at most this often; the alarm only needs day-resolution freshness. */
const ACTIVITY_PERSIST_SLACK_MS = 24 * 60 * 60_000;
/** Presence heartbeats older than this are pruned on the next heartbeat from anyone. */
export const PRESENCE_TTL_MS = 45_000;
const MAX_PRESENCE_ENTRIES = 100;

type SecretHash = { salt: string; hash: string };
type Grant = { grantId: string; permission: GrantPermission; secret: SecretHash; revoked: boolean; revoking?: boolean; authEpoch: number };
type StoredOperation = { fingerprint: string; result: OperationResultV2 };
type StoredTicket = { tokenHash: string; claims: SocketTicketClaimsV2; consumed: boolean };
type BinaryTicket = { tokenHash: string; claims: BinaryUploadTicketClaimsV2 | BinaryReadTicketClaimsV2; createdAt: number; consumed: boolean; uploaded?: boolean; failed?: boolean; verifiedKey?: string };
type BinaryRetentionRoot = { rootId: string; kind: "tombstone" | "offline-recovery" | "migration-snapshot"; key: string; expiresAt: number; operationId: string };
type BinaryGcCandidate = { firstRoundCompletedAt?: number; rootGeneration: number };
type BinaryGcSweep = { rootGeneration: number; round: 1 | 2; cursor?: string; attempts: number };
type BinaryGcResult = { scanned: number; deleted: number; orphanBacklog: number; round: 1 | 2; truncated?: boolean; waitingForGrace?: boolean };
type PendingFileWork = { kind: "delete" | "close" | "revoke"; fileId: string; documentEpoch: number; authorityEpoch: number; operationId?: string; grantId?: string; grantEpoch?: number; attempts?: number; lastAttemptAt?: number };
type DurableMetadata = { documentEpoch: number; contentRevision: number; snapshotGeneration: number; size: number; hash: string; stateVector: string };
type TextInitializer = { grantId: string; operationId: string; size: number; hash: string; completed?: boolean };
type ImportManifestEntry = { fileId: string; path: string; kind: "text" | "binary" | "board" | "spreadsheet"; size: number; hash: string };
/**
 * `permission` is stamped from the authenticated actor, never from the request
 * body: "who started this share" is the one presence field a client must not be
 * able to claim for itself. Unlike `grantId` it stays visible to every peer, so
 * guests can tell the host apart from each other in the collaborator list.
 */
type PresenceEntry = { name: string; color: string; path: string | null; updatedAt: number; grantId?: string; permission?: GrantPermission };
type CoordinatorState = CatalogV2 & {
  host: SecretHash;
  grants: Grant[];
  operations: Record<string, StoredOperation>;
  operationOrder: string[];
  events: CoordinatorEventV2[];
  tickets: StoredTicket[];
  ticketWindow: { startedAt: number; count: number };
  pendingCloseAcks: string[];
  pendingFileWork?: PendingFileWork[];
  durableMetadata?: Record<string, DurableMetadata>;
  textInitializers?: Record<string, TextInitializer>;
  binaryTickets?: BinaryTicket[];
  binaryReferences?: Record<string, BinaryReferenceV2>;
  binaryConflicts?: BinaryConflictV2[];
  binaryRetentionRoots?: BinaryRetentionRoot[];
  presence?: Record<string, PresenceEntry>;
  lastActivityAt?: number;
  rootGeneration?: number;
  binaryGcCandidates?: Record<string, BinaryGcCandidate>;
  binaryGcSweep?: BinaryGcSweep;
  import?: { operationId: string; expectedManifestHash: string; entries: ImportManifestEntry[]; error?: string; attempts: number };
};

export class ProjectCoordinatorV2 extends DurableObject {
  private state: CoordinatorState | undefined;

  private readonly bindings: { TextFileV2: DurableObjectNamespace<TextFileV2>; BinaryObjects: R2Bucket };

  constructor(ctx: DurableObjectState, env: { TextFileV2: DurableObjectNamespace<TextFileV2>; BinaryObjects: R2Bucket }) {
    super(ctx, env as never);
    this.bindings = env;
    ctx.blockConcurrencyWhile(async () => { this.state = await ctx.storage.get(STATE_KEY); });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const action = parts.at(-1) ?? "";
      if (request.method === "POST" && action === "bootstrap") return await this.bootstrap(request);
      if (!this.state) return fail(404, "not_found", "Project has not been bootstrapped");
      const actor = await this.authenticate(request);
      if (!actor) return this.reject(401, "auth", "Invalid or revoked credential");
      await this.touchActivity();
      if (request.method === "GET" && action === "catalog") return json(publicCatalog(this.state));
      if (request.method === "GET" && action === "events") return this.events(url);
      if (request.method === "GET" && action === "grants") return actor.permission === "host"
        ? json(this.state.grants.map(({ grantId, permission, revoked, authEpoch }) => ({ grantId, permission, revoked, authEpoch })))
        : this.reject(403, "forbidden", "Host permission required");
      if (request.method === "GET" && action === "conflicts" && parts.at(-2) === "binary") return this.listBinaryConflicts(url);
      if (request.method === "GET" && parts.at(-2) === "operations") return this.operationStatus(action);
      if (request.method !== "POST") return fail(405, "method", "Method not allowed");
      const body = await readObject(request);
      if (action === "upload-tickets" && parts.at(-2) === "binary") return this.issueBinaryUpload(body, actor);
      if (action === "read-tickets" && parts.at(-2) === "binary") return this.issueBinaryRead(body, actor);
      if (action === "commit" && parts.at(-2) === "binary") return this.commitBinary(body, actor);
      if (action === "gc" && parts.at(-2) === "binary") return actor.permission === "host" ? this.sweepBinaryGc(body) : this.reject(403, "forbidden", "Host permission required");
      if (action === "presence") return this.updatePresence(body, actor);
      if ((action === "pin" || action === "release") && parts.at(-3) === "binary") return actor.permission === "host" ? this.mutateRetentionRoot(action, parts.at(-2)!, body) : this.reject(403, "forbidden", "Host permission required");
      return await this.mutate(action, body, actor);
    } catch (error) {
      if (error instanceof ControlError) return fail(error.status, error.code, error.message, error.extra);
      return fail(400, "invalid_request", error instanceof Error ? error.message : "Invalid request");
    }
  }

  private async bootstrap(request: Request): Promise<Response> {
    if (this.state) return fail(409, "already_exists", "Project already exists");
    const body = await readObject(request);
    const projectInstanceId = requiredString(body.projectInstanceId, "projectInstanceId");
    const projectName = optionalProjectName(body.projectName);
    const routedId = decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean)[2] ?? "");
    if (projectInstanceId !== routedId) throw new Error("projectInstanceId must match the routed coordinator");
    const hostSecret = strongSecret(body.hostSecret);
    const rawManifest = body.importManifest;
    const entries = rawManifest === undefined ? [] : parseImportManifest(rawManifest);
    if (entries.length && await digest(canonicalJson(entries)) !== body.expectedManifestHash) throw new Error("expectedManifestHash does not match canonical import manifest");
    const importPaths = body.paths ?? entries.map((entry) => entry.path);
    if (!Array.isArray(importPaths) || importPaths.length > MAX_FILES) throw new Error("Import file quota exceeded");
    const files = importPaths.map((rawPath, index) => ({
      fileId: entries[index]?.fileId ?? crypto.randomUUID(),
      path: canonicalPath(rawPath),
      kind: entries[index]?.kind ?? requiredFileKind(body.kind),
      state: "initializing" as const,
      documentEpoch: 1,
    }));
    const folded = files.map((file) => file.path.toLocaleLowerCase("en-US"));
    if (new Set(folded).size !== folded.length) throw new Error("Imported paths duplicate or case-collide");
    this.state = {
      protocol: CONTROL_PROTOCOL_VERSION, projectInstanceId, ...(projectName ? { name: projectName } : {}), lifecycle: "importing", catalogRevision: 0,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files, host: await derive(hostSecret),
      grants: [], operations: {}, operationOrder: [], events: [], tickets: [],
      ticketWindow: { startedAt: Date.now(), count: 0 },
      pendingCloseAcks: [],
      pendingFileWork: [], durableMetadata: {},
      binaryTickets: [], binaryReferences: {}, binaryConflicts: [], binaryRetentionRoots: [], rootGeneration: 0, binaryGcCandidates: {},
      lastActivityAt: Date.now(),
      ...(entries.length ? { import: { operationId: requiredString(body.operationId, "operationId"), expectedManifestHash: requiredString(body.expectedManifestHash, "expectedManifestHash"), entries, attempts: 0 } } : {}),
    };
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.ctx.storage.setAlarm(Date.now() + MIN_GC_GRACE_MS);
    log("project_bootstrapped", { projectInstanceId });
    return json(publicCatalog(this.state), 201);
  }

  private async authenticate(request: Request): Promise<{ grantId: string; permission: GrantPermission } | null> {
    const raw = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
    return raw ? this.authenticateCredential(raw) : null;
  }

  private async authenticateCredential(raw: string): Promise<{ grantId: string; permission: GrantPermission } | null> {
    if (!this.state) return null;
    if (await verify(raw, this.state.host)) return { grantId: "host", permission: "host" };
    for (const grant of this.state!.grants) {
      if (!grant.revoked && !grant.revoking && await verify(raw, grant.secret)) return grant;
    }
    return null;
  }

  /** Any authenticated use keeps the project alive past the idle TTL. Rewriting storage is throttled to once a day. */
  private async touchActivity(): Promise<void> {
    const now = Date.now();
    const previous = this.state!.lastActivityAt ?? 0;
    this.state!.lastActivityAt = now;
    if (now - previous > ACTIVITY_PERSIST_SLACK_MS) await this.persist();
  }

  /**
   * Project-level presence: per-file awareness rooms cannot see each other, so
   * clients heartbeat who they are and which file they are in. Entries expire
   * lazily — a crashed client disappears within PRESENCE_TTL_MS.
   */
  private async updatePresence(body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Response> {
    const instanceId = requiredString(body.instanceId, "instanceId");
    if (instanceId.length > 64) throw new Error("Invalid instanceId");
    const now = Date.now();
    const presence = this.state!.presence ??= {};
    for (const [id, entry] of Object.entries(presence)) if (now - entry.updatedAt > PRESENCE_TTL_MS) delete presence[id];
    if (body.leave === true) {
      if (actor.permission === "host" || presence[instanceId]?.grantId === actor.grantId) delete presence[instanceId];
    }
    else {
      const ownerGrantId = presence[instanceId]?.grantId;
      if (actor.permission !== "host" && ownerGrantId && ownerGrantId !== actor.grantId) return this.reject(403, "forbidden", "Presence entry belongs to another collaborator");
      if (!presence[instanceId] && Object.keys(presence).length >= MAX_PRESENCE_ENTRIES) return this.reject(429, "presence_full", "Too many presence entries");
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Anonymous";
      const color = typeof body.color === "string" && body.color ? body.color.slice(0, 40) : "#8b8b93";
      const path = typeof body.path === "string" && body.path ? body.path.slice(0, MAX_PATH) : null;
      presence[instanceId] = { name, color, path, updatedAt: now, grantId: actor.grantId, permission: actor.permission };
    }
    await this.persist();
    const visiblePresence = actor.permission === "host"
      ? presence
      : Object.fromEntries(Object.entries(presence).map(([id, { grantId: _grantId, ...entry }]) => [id, entry]));
    return json({ protocol: CONTROL_PROTOCOL_VERSION, presence: visiblePresence });
  }

  /** Idempotency log append with the bounded-retention prune in exactly one place. */
  private recordOperation(operationId: string, fingerprint: string, result: OperationResultV2): void {
    this.state!.operations[operationId] = { fingerprint, result };
    this.state!.operationOrder.push(operationId);
    while (this.state!.operationOrder.length > MAX_OPERATIONS) delete this.state!.operations[this.state!.operationOrder.shift()!];
  }

  private async mutate(action: string, body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Response> {
    if (action === "tickets") return await this.issueTicket(body, actor);
    const hostActions = new Set(["import-finalize", "file-ready", "delete-ack", "grants", "revoke", "project-rename", "close-begin", "close-ack"]);
    if (hostActions.has(action) && actor.permission !== "host") return this.reject(403, "forbidden", "Host permission required");
    if (["create", "rename", "delete-begin"].includes(action) && actor.permission === "read") return this.reject(403, "forbidden", "Write permission required");
    const operationId = requiredString(body.operationId, "operationId");
    const fingerprint = await digest(canonicalJson({ action, body }));
    const old = this.state!.operations[operationId];
    if (old) return old.fingerprint === fingerprint ? json(old.result) : fail(409, "operation_id_reuse", "Operation ID was used for a different request");
    const expected = requiredInteger(body.expectedCatalogRevision, "expectedCatalogRevision");
    if (expected !== this.state!.catalogRevision) return this.reject(409, "catalog_revision_conflict", "Catalog revision does not match", { catalogRevision: this.state!.catalogRevision });
    const result = await this.apply(action, body, actor);
    this.recordOperation(operationId, fingerprint, { ...result, operationId });
    await this.persist();
    if (this.state!.pendingFileWork?.length) await this.ctx.storage.setAlarm(Date.now() + 1);
    return json(this.state!.operations[operationId].result);
  }

  private async apply(action: string, body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Omit<OperationResultV2, "operationId">> {
    const state = this.state!;
    let value: unknown;
    let status: "complete" | "pending" = "complete";
    let pendingAcks: string[] | undefined;
    if (action === "import-finalize") {
      if (state.lifecycle !== "importing") throw new Error("Project is not importing");
      if (state.import) {
        state.import.attempts++;
        if (body.importOperationId !== state.import.operationId || body.expectedManifestHash !== state.import.expectedManifestHash) throw new Error("Import identity does not match bootstrap");
        const actual = state.import.entries.map((entry) => {
          const file = state.files.find((candidate) => candidate.fileId === entry.fileId);
          const metadata = entry.kind === "binary" ? state.binaryReferences?.[entry.fileId] : state.durableMetadata?.[entry.fileId];
          return file && metadata && file.path === entry.path && file.state === "live" && metadata.size === entry.size && metadata.hash === entry.hash;
        });
        if (actual.some((matches) => !matches) || state.files.length !== state.import.entries.length) {
          state.import.error = "catalog_or_content_manifest_mismatch";
          throw new ControlError(409, "import_manifest_mismatch", "Imported catalog/content does not exactly match the fenced source manifest");
        }
      }
      state.lifecycle = "live";
    } else if (action === "project-rename") {
      requireLive(state);
      state.name = requiredProjectName(body.name);
      value = { name: state.name };
    } else if (action === "create") {
      requireLive(state);
      if (state.files.filter((f) => f.state !== "purging").length >= MAX_FILES) throw new Error("File quota exceeded");
      const path = canonicalPath(body.path);
      ensurePathFree(state, path);
      const file: CatalogFileV2 = { fileId: crypto.randomUUID(), path, kind: requiredFileKind(body.kind), state: "initializing", documentEpoch: 1 };
      if (file.kind !== "binary") {
        const initializer = readObjectValue(body.initializer, "initializer");
        const initializerOperationId = requiredString(initializer.operationId, "initializer.operationId");
        const initializerSize = requiredInteger(initializer.size, "initializer.size");
        const initializerHash = requiredString(initializer.hash, "initializer.hash");
        if (!isOperationId(initializerOperationId) || initializerSize < 0 || initializerSize > 5 * 1024 * 1024 || !isSha256(initializerHash)) throw new Error("Invalid text initializer");
        state.textInitializers ??= {};
        state.textInitializers[file.fileId] = { grantId: actor.grantId, operationId: initializerOperationId, size: initializerSize, hash: initializerHash };
      }
      state.files.push(file); value = file;
    } else if (action === "rename") {
      requireLive(state);
      const file = liveFile(state, requiredString(body.fileId, "fileId"));
      const path = canonicalPath(body.path); ensurePathFree(state, path, file.fileId); file.path = path; value = file;
    } else if (action === "file-ready") {
      const file = findFile(state, requiredString(body.fileId, "fileId"));
      if (file.state !== "initializing") throw new Error("File is not initializing");
      if (file.kind !== "binary") throw new Error("Text files require durable initialization");
      file.state = "live"; value = file;
    } else if (action === "delete-begin") {
      requireLive(state);
      const file = liveFile(state, requiredString(body.fileId, "fileId")); file.state = "preparing-delete"; state.authorityEpoch++;
      const work: PendingFileWork = { kind: "delete", fileId: file.fileId, documentEpoch: file.documentEpoch, authorityEpoch: state.authorityEpoch, operationId: requiredString(body.operationId, "operationId") };
      await this.persist();
      let fenced = file.kind === "binary";
      if (!fenced) {
        try { fenced = await this.bindings.TextFileV2.getByName(textFileV2RoomName(state.projectInstanceId, file.fileId, file.documentEpoch)).fenceForDeletion(state.projectInstanceId, file.fileId, file.documentEpoch, state.authorityEpoch); }
        catch { fenced = false; }
      }
      if (fenced) { file.state = "tombstoned"; this.retireBinaryReference(file); }
      else { status = "pending"; pendingAcks = [`file-fence:${file.fileId}:${file.documentEpoch}`]; state.pendingFileWork = upsertWork(state.pendingFileWork, work); }
      value = file;
    } else if (action === "delete-ack") {
      const file = findFile(state, requiredString(body.fileId, "fileId"));
      if (file.state !== "deleting" && file.state !== "preparing-delete") throw new Error("File is not awaiting a fence");
      if (body.ack !== `file-fence:${file.fileId}:${file.documentEpoch}`) throw new Error("Wrong file fence acknowledgement");
      file.state = "tombstoned"; value = file;
      this.retireBinaryReference(file);
    } else if (action === "grants") {
      if (state.lifecycle === "closing" || state.lifecycle === "closed") throw new Error("Project is closing");
      if (state.grants.length >= MAX_GRANTS) throw new Error("Grant quota exceeded");
      const permission: GrantPermission | unknown = body.permission;
      if (permission !== "read" && permission !== "write") throw new Error("Invalid guest permission");
      const secret = secretHash(body.guestSecretHash);
      const grant: Grant = { grantId: crypto.randomUUID(), permission, secret, revoked: false, authEpoch: 1 };
      state.grants.push(grant); value = { grantId: grant.grantId, permission };
    } else if (action === "revoke") {
      const grant = state.grants.find((g) => g.grantId === body.grantId); if (!grant) throw new Error("Grant not found");
      if (!grant.revoked && !grant.revoking) { grant.revoking = true; grant.authEpoch++; state.authorityEpoch++; }
      for (const [instanceId, entry] of Object.entries(state.presence ?? {})) if (entry.grantId === grant.grantId) delete state.presence![instanceId];
      await this.persist();
      const failed: string[] = [];
      for (const file of state.files.filter((item) => item.kind !== "binary" && (item.state === "live" || item.state === "initializing"))) {
        const work: PendingFileWork = { kind: "revoke", fileId: file.fileId, documentEpoch: file.documentEpoch, authorityEpoch: state.authorityEpoch, operationId: requiredString(body.operationId, "operationId"), grantId: grant.grantId, grantEpoch: grant.authEpoch };
        try { if (!await this.bindings.TextFileV2.getByName(textFileV2RoomName(state.projectInstanceId, file.fileId, file.documentEpoch)).revokeGrant(grant.grantId, grant.authEpoch, state.authorityEpoch)) failed.push(file.fileId); }
        catch { failed.push(file.fileId); }
        if (failed.includes(file.fileId)) state.pendingFileWork = upsertWork(state.pendingFileWork, work);
      }
      if (failed.length) { status = "pending"; pendingAcks = failed.map((id) => `grant-revoke:${id}:${grant.authEpoch}`); }
      else { grant.revoked = true; grant.revoking = false; }
      value = { grantId: grant.grantId, authEpoch: grant.authEpoch };
    } else if (action === "close-begin") {
      if (state.lifecycle !== "live") throw new Error("Project is not live"); state.lifecycle = "closing"; state.authorityEpoch++;
      pendingAcks = state.files.filter((f) => f.state === "live" || f.state === "initializing").map((f) => `file-close:${f.fileId}:${f.documentEpoch}`);
      state.pendingCloseAcks = pendingAcks;
      state.pendingFileWork = state.files.filter((f) => f.state === "live" || f.state === "initializing").reduce((work, f) => upsertWork(work, { kind: "close", fileId: f.fileId, documentEpoch: f.documentEpoch, authorityEpoch: state.authorityEpoch, operationId: requiredString(body.operationId, "operationId") }), state.pendingFileWork ?? []);
      await this.persist();
      for (const work of [...state.pendingFileWork.filter((item) => item.kind === "close")]) {
        let fenced = false;
        const file = state.files.find((item) => item.fileId === work.fileId);
        if (file?.kind === "binary") fenced = true;
        else try { fenced = await this.bindings.TextFileV2.getByName(textFileV2RoomName(state.projectInstanceId, work.fileId, work.documentEpoch)).fenceForProjectClose(state.projectInstanceId, work.fileId, work.documentEpoch, state.authorityEpoch); } catch { fenced = false; }
        if (fenced) {
          state.pendingCloseAcks = state.pendingCloseAcks.filter((ack) => ack !== `file-close:${work.fileId}:${work.documentEpoch}`);
          state.pendingFileWork = state.pendingFileWork.filter((item) => item !== work);
        }
      }
      if (state.pendingCloseAcks.length) { status = "pending"; pendingAcks = state.pendingCloseAcks; }
      else { state.lifecycle = "closed"; state.grants.forEach((grant) => { grant.revoked = true; }); pendingAcks = undefined; }
    } else if (action === "close-ack") {
      if (state.lifecycle !== "closing") throw new Error("Project is not closing");
      const ack = requiredString(body.ack, "ack");
      if (!state.pendingCloseAcks.includes(ack)) throw new Error("Unknown or already received close acknowledgement");
      state.pendingCloseAcks = state.pendingCloseAcks.filter((item) => item !== ack);
      if (state.pendingCloseAcks.length) { status = "pending"; pendingAcks = state.pendingCloseAcks; }
      else { state.lifecycle = "closed"; state.grants.forEach((g) => { g.revoked = true; }); }
    } else throw new Error("Unknown operation");
    this.bump(action, typeof value === "object" && value && "fileId" in value ? String((value as { fileId: string }).fileId) : undefined);
    log("coordinator_lifecycle", { projectInstanceId: state.projectInstanceId, action, catalogRevision: state.catalogRevision, backlog: pendingAcks?.length ?? 0 });
    return { status, catalogRevision: state.catalogRevision, value, pendingAcks };
  }

  private async issueTicket(body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Response> {
    const state = this.state!; requireLive(state);
    const now = Date.now();
    if (now - state.ticketWindow.startedAt >= 60_000) state.ticketWindow = { startedAt: now, count: 0 };
    if (++state.ticketWindow.count > MAX_TICKETS_PER_MINUTE) return fail(429, "ticket_quota", "Ticket issuance quota exceeded");
    const audience = body.audience;
    if (audience !== "project" && audience !== "file") throw new Error("Invalid ticket audience");
    let file: CatalogFileV2 | undefined;
    if (audience === "file") {
      file = liveFile(state, requiredString(body.fileId, "fileId"));
      if (file.kind === "binary") throw new Error("Text socket tickets require a text-synced file");
    }
    const token = randomSecret();
    const grantEpoch = actor.grantId === "host" ? 1 : state.grants.find((grant) => grant.grantId === actor.grantId)?.authEpoch;
    if (grantEpoch === undefined) return this.reject(403, "invalid_grant", "Grant is unavailable");
    const claims: SocketTicketClaimsV2 = { protocol: 2, projectInstanceId: state.projectInstanceId, audience, fileId: file?.fileId, documentEpoch: file?.documentEpoch, grantId: actor.grantId, permission: actor.permission, grantEpoch, projectAuthorityEpoch: state.authorityEpoch, expiresAt: now + TICKET_TTL_MS };
    state.tickets.push({ tokenHash: await digest(token), claims, consumed: false });
    state.tickets = state.tickets.filter((t) => !t.consumed && t.claims.expiresAt > now).slice(-MAX_TICKETS_PER_MINUTE * 2);
    await this.persist(); return json({ ticket: token, claims });
  }

  async consumeSocketTicket(ticket: string, audience: "project" | "file", fileId?: string, documentEpoch?: number): Promise<SocketTicketClaimsV2 | null> {
    if (!this.state) return null;
    const hash = await digest(ticket); const found = this.state.tickets.find((t) => t.tokenHash === hash);
    if (!found || found.consumed || found.claims.expiresAt <= Date.now() || found.claims.projectInstanceId !== this.state.projectInstanceId
      || found.claims.audience !== audience || (audience === "file" && (found.claims.fileId !== fileId || (documentEpoch !== undefined && found.claims.documentEpoch !== documentEpoch)))) return null;
    if (audience === "file") {
      const file = this.state.files.find((item) => item.fileId === found.claims.fileId);
      if (!file || file.state !== "live" || file.documentEpoch !== found.claims.documentEpoch) return null;
    }
    const grant = found.claims.grantId === "host" ? null : this.state.grants.find((g) => g.grantId === found.claims.grantId);
    if (grant?.revoked || this.state.lifecycle !== "live") return null;
    found.consumed = true; await this.persist(); return found.claims;
  }

  /** Fail-closed data-plane authorization. TextFileV2 calls this before accepting every mutating Yjs frame. */
  async authorizeTextMessage(projectInstanceId: string, fileId: string, documentEpoch: number, grantId: string, grantEpoch: number, projectAuthorityEpoch: number): Promise<boolean> {
    if (!this.state || this.state.projectInstanceId !== projectInstanceId || this.state.lifecycle !== "live") return false;
    if (!Number.isSafeInteger(grantEpoch) || !Number.isSafeInteger(projectAuthorityEpoch) || projectAuthorityEpoch !== this.state.authorityEpoch) return false;
    const file = this.state.files.find((item) => item.fileId === fileId);
    if (!file || file.state !== "live" || file.documentEpoch !== documentEpoch) return false;
    if (grantId === "host") return grantEpoch === 1;
    const grant = this.state.grants.find((item) => item.grantId === grantId);
    return !!grant && !grant.revoked && !grant.revoking && grant.authEpoch === grantEpoch && grant.permission === "write";
  }

  private async issueBinaryUpload(body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Response> {
    const importing = this.state!.lifecycle === "importing" && actor.permission === "host" && body.import === true;
    if (!importing) requireLive(this.state!);
    if (actor.permission === "read") return this.reject(403, "forbidden", "Write permission required");
    const file = liveFile(this.state!, requiredString(body.fileId, "fileId"));
    if (file.kind !== "binary") throw new Error("Binary uploads require a binary file");
    const documentEpoch = requiredInteger(body.documentEpoch, "documentEpoch");
    if (file.documentEpoch !== documentEpoch) return this.reject(409, "stale_epoch", "Document epoch does not match");
    if (!isSha256(body.declaredHash) || !isBinarySize(body.declaredSize) || !isBinaryContentType(body.contentType) || !isOperationId(body.operationId)) throw new Error("Invalid binary upload claims");
    if (importing) {
      const entry = this.state!.import?.entries.find((item) => item.fileId === file.fileId);
      if (!entry || entry.kind !== "binary" || entry.hash !== body.declaredHash || entry.size !== body.declaredSize || file.state !== "initializing") return this.reject(409, "import_manifest_mismatch", "Binary import does not match manifest");
    }
    const expectedCatalogRevision = requiredInteger(body.expectedCatalogRevision, "expectedCatalogRevision");
    const expectedContentRevision = requiredInteger(body.expectedContentRevision, "expectedContentRevision");
    const prior = body.expectedPriorHash;
    if (prior !== undefined && !isSha256(prior)) throw new Error("Invalid expectedPriorHash");
    const token = randomSecret();
    const grantEpoch = actor.grantId === "host" ? 1 : this.state!.grants.find((grant) => grant.grantId === actor.grantId)!.authEpoch;
    const claims: BinaryUploadTicketClaimsV2 = { protocol: 2, kind: "binary-upload", projectInstanceId: this.state!.projectInstanceId, fileId: file.fileId, documentEpoch, grantId: actor.grantId, permission: actor.permission, grantEpoch, projectAuthorityEpoch: this.state!.authorityEpoch, expectedCatalogRevision, expectedContentRevision, ...(prior ? { expectedPriorHash: prior } : {}), declaredHash: body.declaredHash, declaredSize: body.declaredSize, contentType: body.contentType, operationId: body.operationId, expiresAt: Date.now() + TICKET_TTL_MS };
    this.state!.binaryTickets ??= [];
    const now = Date.now();
    this.state!.binaryTickets = this.state!.binaryTickets.filter((item) => item.claims.expiresAt > now && !item.failed).slice(-MAX_TICKETS_PER_MINUTE * 2);
    this.state!.binaryTickets.push({ tokenHash: await digest(token), claims, createdAt: now, consumed: false });
    await this.persist();
    return json({ ticket: token, expiresAt: claims.expiresAt });
  }

  /** Trusted Worker seam. Consumes the ticket before bytes are accepted. */
  async consumeBinaryUploadTicket(token: string): Promise<BinaryUploadTicketClaimsV2 | null> {
    const ticket = await this.validBinaryTicket(token, "binary-upload");
    if (!ticket) return null;
    ticket.consumed = true; await this.persist();
    return ticket.claims as BinaryUploadTicketClaimsV2;
  }

  async markBinaryUploaded(token: string, claims: BinaryUploadTicketClaimsV2, key: string): Promise<boolean> {
    const hash = await digest(token);
    const item = this.state?.binaryTickets?.find((ticket) => ticket.tokenHash === hash);
    if (!item || item.claims.kind !== "binary-upload" || !item.consumed || item.failed || item.claims.expiresAt <= Date.now()) return false;
    if (canonicalJson(item.claims) !== canonicalJson(claims) || key !== binaryKey(claims.projectInstanceId, claims.fileId, claims.declaredHash) || !this.ticketAuthorityValid(item, "binary-upload")) return false;
    item.uploaded = true; item.verifiedKey = key; this.bumpRoots(); await this.persist(); return true;
  }

  private async commitBinary(body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Response> {
    const token = requiredString(body.ticket, "ticket");
    const hash = await digest(token);
    const ticket = this.state!.binaryTickets?.find((item) => item.tokenHash === hash);
    if (!ticket || ticket.claims.kind !== "binary-upload" || !ticket.uploaded || ticket.failed || ticket.claims.grantId !== actor.grantId || ticket.claims.expiresAt <= Date.now() || !this.ticketAuthorityValid(ticket, "binary-upload")) return this.reject(403, "invalid_ticket", "Upload ticket is not committed and verified");
    const claims = ticket.claims;
    const operationId = requiredString(body.operationId, "operationId");
    if (operationId !== claims.operationId) throw new Error("operationId does not match ticket");
    const old = this.state!.operations[operationId];
    const fingerprint = await digest(canonicalJson({ action: "binary-commit", claims }));
    if (old) return old.fingerprint === fingerprint ? json(old.result.value) : fail(409, "operation_id_reuse", "Operation ID was used for different binary claims");
    if (this.state!.lifecycle !== "importing") requireLive(this.state!);
    const file = this.state!.files.find((entry) => entry.fileId === claims.fileId);
    if (!file || (file.state !== "live" && !(this.state!.lifecycle === "importing" && claims.grantId === "host" && file.state === "initializing")) || file.documentEpoch !== claims.documentEpoch) return this.reject(409, "stale_file", "File is no longer writable");
    const key = binaryKey(claims.projectInstanceId, claims.fileId, claims.declaredHash);
    const head = await this.bindings.BinaryObjects.head(key);
    if (!head || head.size !== claims.declaredSize || head.customMetadata?.sha256 !== claims.declaredHash || head.customMetadata?.version !== BINARY_OBJECT_VERSION) return this.reject(409, "object_unverified", "Verified binary object is unavailable");
    const current = this.state!.binaryReferences?.[claims.fileId];
    const nextRevision = (current?.contentRevision ?? file.contentRevision ?? 0) + 1;
    const reference: BinaryReferenceV2 = { fileId: claims.fileId, documentEpoch: claims.documentEpoch, contentRevision: nextRevision, hash: claims.declaredHash, size: claims.declaredSize, contentType: claims.contentType };
    let value: unknown;
    if ((current?.contentRevision ?? 0) !== claims.expectedContentRevision || current?.hash !== claims.expectedPriorHash) {
      const conflict: BinaryConflictV2 = { conflictId: crypto.randomUUID(), fileId: claims.fileId, createdAt: Date.now(), ...(current ? { winner: current } : {}), loser: reference };
      this.state!.binaryConflicts ??= []; this.state!.binaryConflicts.push(conflict);
      this.bumpRoots();
      value = { status: "conflict", current, conflict };
    } else {
      this.state!.binaryReferences ??= {}; this.state!.binaryReferences[claims.fileId] = reference;
      this.bumpRoots();
      file.contentRevision = reference.contentRevision; file.hash = reference.hash; file.size = reference.size;
      if (this.state!.lifecycle === "importing") file.state = "live";
      this.bump("binary-commit", file.fileId); value = { status: "complete", current: reference };
    }
    const result: OperationResultV2 = { operationId, status: "complete", catalogRevision: this.state!.catalogRevision, value };
    this.recordOperation(operationId, fingerprint, result);
    await this.persist(); return json(value);
  }

  /** Host trigger only advances the durable state machine; it cannot reduce production grace. */
  private async sweepBinaryGc(body: Record<string, unknown>): Promise<Response> {
    void body;
    return json(await this.runBinaryGc(Date.now(), MIN_GC_GRACE_MS));
  }

  /** Internal DO test seam; production and tests execute the same persisted sweep implementation. */
  async runBinaryGcForTest(now: number, minGraceMs = MIN_GC_GRACE_MS): Promise<BinaryGcResult> {
    return this.runBinaryGc(now, minGraceMs);
  }

  /** Test seam: rewinds the idle clock through the in-memory state so nothing shadows it. */
  async setLastActivityForTest(at: number): Promise<void> {
    if (!this.state) throw new Error("Project has not been bootstrapped");
    this.state.lastActivityAt = at;
    await this.persist();
  }

  /** Test seam: fills the idempotency log to exercise its bounded retention. */
  async seedOperationsForTest(count: number): Promise<void> {
    for (let index = 0; index < count; index++) this.recordOperation(`seed-${index}`, "seed", { operationId: `seed-${index}`, status: "complete", catalogRevision: 0 });
    await this.persist();
  }

  /** Test seam: backdates a presence entry to exercise lazy expiry. */
  async seedPresenceForTest(instanceId: string, entry: PresenceEntry): Promise<void> {
    (this.state!.presence ??= {})[instanceId] = entry;
    await this.persist();
  }

  private async runBinaryGc(now: number, graceMs: number): Promise<BinaryGcResult> {
    const state = this.state!;
    state.rootGeneration ??= 0;
    const roots = new Set<string>();
    for (const reference of Object.values(state.binaryReferences ?? {})) roots.add(binaryKey(state.projectInstanceId, reference.fileId, reference.hash));
    for (const conflict of state.binaryConflicts ?? []) roots.add(binaryKey(state.projectInstanceId, conflict.fileId, conflict.loser.hash));
    const retained = (state.binaryRetentionRoots ?? []).filter((root) => root.expiresAt > now);
    if (retained.length !== (state.binaryRetentionRoots ?? []).length) { state.binaryRetentionRoots = retained; this.bumpRoots(); }
    for (const root of retained) roots.add(root.key);
    for (const ticket of state.binaryTickets ?? []) if (ticket.claims.kind === "binary-upload" && ticket.uploaded && ticket.claims.expiresAt > now && !state.operations[ticket.claims.operationId]) roots.add(binaryKey(state.projectInstanceId, ticket.claims.fileId, ticket.claims.declaredHash));
    state.binaryGcCandidates ??= {};
    if (!state.binaryGcSweep || state.binaryGcSweep.rootGeneration !== state.rootGeneration) {
      state.binaryGcSweep = { rootGeneration: state.rootGeneration, round: 1, attempts: 0 };
      state.binaryGcCandidates = {};
      await this.persist();
    }
    const sweep = state.binaryGcSweep;
    const completed = Object.values(state.binaryGcCandidates).find((candidate) => candidate.rootGeneration === state.rootGeneration)?.firstRoundCompletedAt;
    if (sweep.round === 2 && (completed === undefined || now - completed < graceMs)) {
      return { scanned: 0, deleted: 0, orphanBacklog: Object.keys(state.binaryGcCandidates).length, waitingForGrace: true, round: 2 };
    }
    const prefix = `v2/${state.projectInstanceId}/`;
    let page: R2Objects;
    try { page = await this.bindings.BinaryObjects.list({ prefix, cursor: sweep.cursor, limit: 100 }); }
    catch (error) { sweep.attempts++; await this.persist(); await this.scheduleGcRetry(sweep.attempts); throw error; }
    let deleted = 0;
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix)) continue;
      if (roots.has(object.key)) { delete state.binaryGcCandidates[object.key]; continue; }
      if (sweep.round === 1) state.binaryGcCandidates[object.key] = { rootGeneration: state.rootGeneration };
      else if (state.binaryGcCandidates[object.key]?.rootGeneration === state.rootGeneration) {
        try { await this.bindings.BinaryObjects.delete(object.key); }
        catch (error) { sweep.attempts++; await this.persist(); await this.scheduleGcRetry(sweep.attempts); throw error; }
        delete state.binaryGcCandidates[object.key]; deleted++;
      }
    }
    sweep.attempts = 0;
    sweep.cursor = page.truncated ? page.cursor : undefined;
    if (!page.truncated) {
      if (sweep.round === 1 && Object.keys(state.binaryGcCandidates).length) {
        for (const candidate of Object.values(state.binaryGcCandidates)) candidate.firstRoundCompletedAt = now;
        sweep.round = 2;
      } else {
        // Round 2 with zero candidates has nothing to delete: finish now.
        // Entering the round-2 grace wait without a stamped candidate would
        // park the sweep in `waitingForGrace` until the next root bump, so an
        // object orphaned without a generation change (e.g. an expired
        // uncommitted upload ticket) would never be collected.
        state.binaryGcSweep = { rootGeneration: state.rootGeneration, round: 1, attempts: 0 };
        state.binaryGcCandidates = {};
      }
    }
    await this.persist();
    const backlog = Object.keys(state.binaryGcCandidates).length;
    console.info(JSON.stringify({ event: "binary_gc", projectInstanceId: state.projectInstanceId, scanned: page.objects.length, deleted, orphanBacklog: backlog, round: sweep.round }));
    return { scanned: page.objects.length, deleted, orphanBacklog: backlog, truncated: page.truncated, round: state.binaryGcSweep.round };
  }

  private async scheduleGcRetry(attempts: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + Math.min(5 * 60_000, 2_000 * (2 ** Math.min(8, attempts - 1))));
  }

  /**
   * Idle-TTL reclaim (v1 room-TTL parity): wipe every text file DO, every R2
   * object under the project prefix, then the coordinator itself. Each step is
   * idempotent; a failure keeps the coordinator alive so the next alarm retries
   * instead of stranding half-wiped data with no state left to find it.
   */
  private async expireProject(): Promise<void> {
    const state = this.state!;
    log("project_idle_expired", { projectInstanceId: state.projectInstanceId });
    let failed = false;
    for (const file of state.files) {
      try { await this.bindings.TextFileV2.getByName(textFileV2RoomName(state.projectInstanceId, file.fileId, file.documentEpoch)).destroyForExpiry(state.projectInstanceId, file.fileId, file.documentEpoch); }
      catch (error) { failed = true; console.warn(JSON.stringify({ event: "project_expiry_file_failed", projectInstanceId: state.projectInstanceId, fileId: file.fileId, error: String(error) })); }
    }
    try {
      let cursor: string | undefined;
      do {
        const page = await this.bindings.BinaryObjects.list({ prefix: `v2/${state.projectInstanceId}/`, cursor, limit: 500 });
        for (const object of page.objects) await this.bindings.BinaryObjects.delete(object.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch (error) { failed = true; console.warn(JSON.stringify({ event: "project_expiry_r2_failed", projectInstanceId: state.projectInstanceId, error: String(error) })); }
    if (failed) { await this.ctx.storage.setAlarm(Date.now() + 60_000); return; }
    // Drop the reference before deleteAll so an interleaved request fails on
    // the persist() guard instead of resurrecting reclaimed state.
    this.state = undefined;
    await this.ctx.storage.deleteAll();
  }

  private listBinaryConflicts(url: URL): Response {
    const fileId = url.searchParams.get("fileId");
    const conflicts = (this.state!.binaryConflicts ?? []).filter((item) => !fileId || item.fileId === fileId);
    return json({ conflicts });
  }

  /**
   * A tombstoned binary's R2 object moves from the live references into a
   * 30-day retention root: the GC keeps it recoverable for a grace period,
   * then reclaims it. Without this the reference leaks forever (the GC treats
   * it as a live root and the object is never deleted).
   */
  private retireBinaryReference(file: CatalogFileV2): void {
    const reference = this.state!.binaryReferences?.[file.fileId];
    if (!reference) return;
    this.state!.binaryRetentionRoots ??= [];
    this.state!.binaryRetentionRoots.push({ rootId: crypto.randomUUID(), kind: "tombstone", key: binaryKey(this.state!.projectInstanceId, file.fileId, reference.hash), expiresAt: Date.now() + 30 * 24 * 60 * 60_000, operationId: `delete:${file.fileId}:${file.documentEpoch}` });
    delete this.state!.binaryReferences![file.fileId];
    this.bumpRoots();
  }

  private async mutateRetentionRoot(action: string, rawKind: string, body: Record<string, unknown>): Promise<Response> {
    const kind = rawKind === "offline-recovery" ? "offline-recovery" : rawKind === "migration-snapshot" ? "migration-snapshot" : null;
    if (!kind) throw new Error("Invalid retention root kind");
    const operationId = requiredString(body.operationId, "operationId");
    this.state!.binaryRetentionRoots ??= [];
    const existing = this.state!.binaryRetentionRoots.find((root) => root.operationId === operationId);
    if (existing) return json(existing);
    if (action === "release") {
      const rootId = requiredString(body.rootId, "rootId");
      this.state!.binaryRetentionRoots = this.state!.binaryRetentionRoots.filter((root) => root.rootId !== rootId || root.kind !== kind);
      this.bumpRoots(); await this.persist(); return json({ rootId, released: true });
    }
    const fileId = requiredString(body.fileId, "fileId");
    const hash = requiredString(body.hash, "hash");
    if (!isSha256(hash)) throw new Error("Invalid hash");
    const ttlMs = Math.min(MAX_RETENTION_TTL_MS, requiredInteger(body.ttlMs, "ttlMs"));
    if (ttlMs <= 0) throw new Error("ttlMs must be positive");
    const root: BinaryRetentionRoot = { rootId: crypto.randomUUID(), kind, key: binaryKey(this.state!.projectInstanceId, fileId, hash), expiresAt: Date.now() + ttlMs, operationId };
    this.state!.binaryRetentionRoots.push(root); this.bumpRoots(); await this.persist(); return json(root);
  }

  private async issueBinaryRead(body: Record<string, unknown>, actor: { grantId: string; permission: GrantPermission }): Promise<Response> {
    requireLive(this.state!);
    const file = liveFile(this.state!, requiredString(body.fileId, "fileId"));
    if (file.kind !== "binary") throw new Error("Binary downloads require a binary file");
    if (file.documentEpoch !== requiredInteger(body.documentEpoch, "documentEpoch")) return this.reject(409, "stale_epoch", "Document epoch does not match");
    const conflictId = body.conflictId === undefined ? undefined : requiredString(body.conflictId, "conflictId");
    const reference = conflictId ? this.state!.binaryConflicts?.find((item) => item.conflictId === conflictId && item.fileId === file.fileId)?.loser : this.state!.binaryReferences?.[file.fileId];
    if (!reference) return this.reject(404, "binary_not_found", "Binary version not found");
    const token = randomSecret();
    const grantEpoch = actor.grantId === "host" ? 1 : this.state!.grants.find((grant) => grant.grantId === actor.grantId)!.authEpoch;
    const claims: BinaryReadTicketClaimsV2 = { protocol: 2, kind: "binary-read", projectInstanceId: this.state!.projectInstanceId, fileId: file.fileId, documentEpoch: file.documentEpoch, grantId: actor.grantId, grantEpoch, projectAuthorityEpoch: this.state!.authorityEpoch, hash: reference.hash, size: reference.size, contentType: reference.contentType, ...(conflictId ? { conflictId } : {}), expiresAt: Date.now() + TICKET_TTL_MS };
    this.state!.binaryTickets ??= [];
    const now = Date.now();
    // Same trimming as upload tickets: without it every download grows the DO state.
    this.state!.binaryTickets = this.state!.binaryTickets.filter((item) => item.claims.expiresAt > now && !item.failed).slice(-MAX_TICKETS_PER_MINUTE * 2);
    this.state!.binaryTickets.push({ tokenHash: await digest(token), claims, createdAt: now, consumed: false }); await this.persist();
    return json({ ticket: token, hash: reference.hash, size: reference.size, contentType: reference.contentType, expiresAt: claims.expiresAt });
  }

  async consumeBinaryReadTicket(token: string): Promise<BinaryReadTicketClaimsV2 | null> {
    const ticket = await this.validBinaryTicket(token, "binary-read"); if (!ticket) return null;
    ticket.consumed = true; await this.persist(); return ticket.claims as BinaryReadTicketClaimsV2;
  }

  private async validBinaryTicket(token: string, kind: BinaryTicket["claims"]["kind"]): Promise<BinaryTicket | null> {
    if (!this.state || (this.state.lifecycle !== "live" && this.state.lifecycle !== "importing")) return null;
    const hash = await digest(token); const ticket = this.state.binaryTickets?.find((entry) => entry.tokenHash === hash);
    if (!ticket || ticket.consumed || ticket.claims.kind !== kind || ticket.claims.expiresAt <= Date.now()) return null;
    return this.ticketAuthorityValid(ticket, kind) ? ticket : null;
  }

  private ticketAuthorityValid(ticket: BinaryTicket, kind: BinaryTicket["claims"]["kind"]): boolean {
    if (!this.state || (this.state.lifecycle !== "live" && this.state.lifecycle !== "importing") || ticket.claims.projectInstanceId !== this.state.projectInstanceId || ticket.claims.kind !== kind) return false;
    const file = this.state.files.find((entry) => entry.fileId === ticket.claims.fileId);
    const grant = ticket.claims.grantId === "host" ? undefined : this.state.grants.find((entry) => entry.grantId === ticket.claims.grantId);
    if (!file || (file.state !== "live" && !(this.state.lifecycle === "importing" && ticket.claims.grantId === "host" && file.state === "initializing")) || file.documentEpoch !== ticket.claims.documentEpoch || ticket.claims.projectAuthorityEpoch !== this.state.authorityEpoch || (ticket.claims.grantId !== "host" && (!grant || grant.revoked || grant.revoking || grant.authEpoch !== ticket.claims.grantEpoch))) return false;
    return true;
  }

  /** Trusted Worker seam: authorize bootstrap imports or a writer's newly-created text initializer. */
  async authorizeTextImport(credential: string, fileId: string, documentEpoch: number, operationId: string, size: number, hash: string): Promise<boolean> {
    if (!this.state || !isOperationId(operationId) || !isSha256(hash)) return false;
    const file = this.state.files.find((item) => item.fileId === fileId);
    const metadata = this.state.durableMetadata?.[fileId];
    const replay = file?.state === "live" && metadata?.size === size && metadata.hash === hash;
    if (!file || (file.state !== "initializing" && !replay) || file.documentEpoch !== documentEpoch || (file.kind !== "text" && file.kind !== "board" && file.kind !== "spreadsheet")) return false;
    if (this.state.lifecycle === "live") {
      const actor = await this.authenticateCredential(credential);
      const initializer = this.state.textInitializers?.[fileId];
      return !!actor && actor.permission !== "read" && !!initializer
        && actor.grantId === initializer.grantId
        && operationId === initializer.operationId
        && size === initializer.size
        && hash === initializer.hash;
    }
    if (this.state.lifecycle !== "importing" || !await verify(credential, this.state.host)) return false;
    const entry = this.state.import?.entries.find((item) => item.fileId === fileId);
    return !!entry && (entry.kind === "text" || entry.kind === "board" || entry.kind === "spreadsheet") && entry.size === size && entry.hash === hash;
  }

  async completeTextImport(fileId: string, documentEpoch: number, size: number, hash: string): Promise<boolean> {
    if (!this.state || (this.state.lifecycle !== "importing" && this.state.lifecycle !== "live")) return false;
    const file = this.state.files.find((item) => item.fileId === fileId);
    const entry = this.state.import?.entries.find((item) => item.fileId === fileId);
    const metadata = this.state.durableMetadata?.[fileId];
    if (!file || file.documentEpoch !== documentEpoch || (file.kind !== "text" && file.kind !== "board" && file.kind !== "spreadsheet")) return false;
    if (file.state === "live") return metadata?.size === size && metadata.hash === hash;
    if (file.state !== "initializing") return false;
    if (this.state.lifecycle === "importing" && (!entry || (entry.kind !== "text" && entry.kind !== "board" && entry.kind !== "spreadsheet") || entry.size !== size || entry.hash !== hash)) return false;
    const initializer = this.state.textInitializers?.[fileId];
    if (this.state.lifecycle === "live" && (!initializer || initializer.size !== size || initializer.hash !== hash)) return false;
    if (!metadata) return false;
    if (initializer) initializer.completed = true;
    metadata.size = size; metadata.hash = hash; file.size = size; file.hash = hash; file.state = "live";
    this.bump("file-ready", fileId); await this.persist(); return true;
  }

  /** Trusted DO-to-DO seam: callers must already hold this coordinator stub. */
  async acknowledgeFileReady(fileId: string, documentEpoch: number): Promise<boolean> {
    return this.internalFileTransition(fileId, documentEpoch, "initializing", "live");
  }

  /** Trusted DO-to-DO seam: exact IDs and epochs prevent stale File DO acknowledgements. */
  async acknowledgeFileDeleted(fileId: string, documentEpoch: number): Promise<boolean> {
    const file = this.state?.files.find((item) => item.fileId === fileId);
    if (file?.documentEpoch === documentEpoch && file.state === "tombstoned") {
      await this.removeWork("delete", fileId, documentEpoch);
      return true;
    }
    const accepted = await this.internalFileTransition(fileId, documentEpoch, "deleting", "tombstoned");
    if (accepted) await this.removeWork("delete", fileId, documentEpoch);
    return accepted;
  }

  async acknowledgeFileClosed(fileId: string, documentEpoch: number): Promise<boolean> {
    if (!this.state) return false;
    const ack = `file-close:${fileId}:${documentEpoch}`;
    const file = this.state.files.find((item) => item.fileId === fileId);
    if ((this.state.lifecycle === "closing" || this.state.lifecycle === "closed")
      && file?.documentEpoch === documentEpoch && !this.state.pendingCloseAcks.includes(ack)
      && !this.state.pendingFileWork?.some((work) => work.kind === "close" && work.fileId === fileId && work.documentEpoch === documentEpoch)) return true;
    if (this.state.lifecycle !== "closing") return false;
    if (!this.state.pendingCloseAcks.includes(ack)) return false;
    this.state.pendingCloseAcks = this.state.pendingCloseAcks.filter((item) => item !== ack);
    if (!this.state.pendingCloseAcks.length) {
      this.state.lifecycle = "closed";
      this.state.grants.forEach((grant) => { grant.revoked = true; });
    }
    this.state.pendingFileWork = this.state.pendingFileWork?.filter((work) => !(work.kind === "close" && work.fileId === fileId && work.documentEpoch === documentEpoch));
    this.bump("close-ack", fileId); await this.persist(); return true;
  }

  /** Cache only: TextFileV2 remains the authority deciding which Yjs updates are accepted. */
  async updateTextDurableMetadata(fileId: string, documentEpoch: number, contentRevision: number, snapshotGeneration: number, size: number, hash: string, stateVector: string): Promise<boolean> {
    if (!this.state || (this.state.lifecycle !== "live" && this.state.lifecycle !== "importing")) return false;
    const file = this.state.files.find((item) => item.fileId === fileId);
    if (!file || (file.state !== "live" && !((this.state.lifecycle === "importing" || this.state.lifecycle === "live") && file.state === "initializing")) || file.documentEpoch !== documentEpoch) return false;
    const previous = this.state.durableMetadata?.[fileId];
    if (previous && contentRevision < previous.contentRevision) return false;
    if (previous && contentRevision === previous.contentRevision) return previous.snapshotGeneration === snapshotGeneration && previous.hash === hash;
    this.state.durableMetadata ??= {};
    this.state.durableMetadata[fileId] = { documentEpoch, contentRevision, snapshotGeneration, size, hash, stateVector };
    file.contentRevision = contentRevision; file.size = size; file.hash = hash;
    await this.persist(); return true;
  }

  override async alarm(): Promise<void> {
    if (!this.state) return;
    if (this.state.lastActivityAt === undefined) {
      // Projects bootstrapped before the idle TTL existed start their clock now.
      this.state.lastActivityAt = Date.now();
      await this.persist();
    } else if (Date.now() - this.state.lastActivityAt > PROJECT_IDLE_TTL_MS) {
      await this.expireProject();
      return;
    }
    const work = this.state.pendingFileWork?.[0];
    if (!work) {
      try { await this.sweepBinaryGc({}); } catch (error) { console.warn(JSON.stringify({ event: "binary_gc_retry", projectInstanceId: this.state.projectInstanceId, error: String(error) })); }
      // A failed sweep schedules its own short retry backoff; only arm the
      // long-period sweep if nothing sooner is pending.
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > Date.now() + MIN_GC_GRACE_MS) await this.ctx.storage.setAlarm(Date.now() + MIN_GC_GRACE_MS);
      return;
    }
    work.attempts = (work.attempts ?? 0) + 1;
    work.lastAttemptAt = Date.now();
    await this.persist();
    try {
      let accepted = false;
      const file = this.state.files.find((item) => item.fileId === work.fileId && item.documentEpoch === work.documentEpoch);
      if (file) {
        const room = textFileV2RoomName(this.state.projectInstanceId, work.fileId, work.documentEpoch);
        const stub = this.bindings.TextFileV2.getByName(room);
        if (work.kind === "delete") accepted = await stub.fenceForDeletion(this.state.projectInstanceId, work.fileId, work.documentEpoch, work.authorityEpoch);
        else if (work.kind === "close") accepted = await stub.fenceForProjectClose(this.state.projectInstanceId, work.fileId, work.documentEpoch, work.authorityEpoch);
        else accepted = await stub.revokeGrant(work.grantId!, work.grantEpoch!, work.authorityEpoch);
      }
      if (accepted && work.kind === "delete") {
        if (file?.state === "preparing-delete" || file?.state === "deleting") { file.state = "tombstoned"; this.retireBinaryReference(file); }
        await this.removeWork("delete", work.fileId, work.documentEpoch);
        this.completePendingOperation(work.operationId);
        await this.persist();
      } else if (accepted && work.kind === "close") {
        await this.acknowledgeFileClosed(work.fileId, work.documentEpoch);
        if (this.state.lifecycle === "closed") { this.completePendingOperation(work.operationId); await this.persist(); }
      } else if (accepted && work.kind === "revoke") {
        await this.removeWork("revoke", work.fileId, work.documentEpoch, work.grantId);
        if (!this.state.pendingFileWork?.some((item) => item.kind === "revoke" && item.grantId === work.grantId)) {
          const grant = this.state.grants.find((item) => item.grantId === work.grantId);
          if (grant?.revoking && grant.authEpoch === work.grantEpoch) {
            grant.revoked = true; grant.revoking = false; this.completePendingOperation(work.operationId); await this.persist();
          }
        }
      }
    } finally {
      if (this.state.pendingFileWork?.length) {
        const pending = this.state.pendingFileWork[0];
        const retryInMs = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(8, Math.max(0, (pending.attempts ?? 1) - 1))));
        console.warn(JSON.stringify({ event: "coordinator_file_work_backlog", projectInstanceId: this.state.projectInstanceId, kind: pending.kind, fileId: pending.fileId, documentEpoch: pending.documentEpoch, attempts: pending.attempts, retryInMs }));
        await this.ctx.storage.setAlarm(Date.now() + retryInMs);
      }
    }
  }

  private async removeWork(kind: PendingFileWork["kind"], fileId: string, documentEpoch: number, grantId?: string): Promise<void> {
    if (!this.state) return;
    this.state.pendingFileWork = this.state.pendingFileWork?.filter((work) => !(work.kind === kind && work.fileId === fileId && work.documentEpoch === documentEpoch && (kind !== "revoke" || work.grantId === grantId)));
    await this.persist();
  }

  private completePendingOperation(operationId?: string): void {
    if (!operationId) return;
    const operation = this.state?.operations[operationId];
    if (!operation || operation.result.status !== "pending") return;
    operation.result = { ...operation.result, status: "complete", catalogRevision: this.state!.catalogRevision, pendingAcks: undefined };
  }

  private async internalFileTransition(fileId: string, documentEpoch: number, from: CatalogFileV2["state"], to: CatalogFileV2["state"]): Promise<boolean> {
    if (!this.state) return false;
    const file = this.state.files.find((item) => item.fileId === fileId);
    if (!file || file.documentEpoch !== documentEpoch || file.state !== from) return false;
    file.state = to; this.bump(to === "live" ? "file-ready" : "delete-ack", fileId); await this.persist(); return true;
  }

  private events(url: URL): Response {
    const since = Number(url.searchParams.get("since") ?? this.state!.catalogRevision);
    const first = this.state!.events[0]?.catalogRevision ?? this.state!.catalogRevision + 1;
    if (!Number.isSafeInteger(since) || since < first - 1) return fail(409, "event_gap", "Retained events do not cover requested revision", { catalogRevision: this.state!.catalogRevision, refetch: true });
    return json({ catalogRevision: this.state!.catalogRevision, events: this.state!.events.filter((e) => e.catalogRevision > since), refetch: false });
  }

  private operationStatus(id: string): Response { const op = this.state!.operations[id]; return op ? json(op.result) : fail(404, "operation_not_found", "Operation was not retained"); }
  private bump(type: string, fileId?: string): void { this.state!.catalogRevision++; this.state!.events.push({ catalogRevision: this.state!.catalogRevision, type, fileId }); this.state!.events = this.state!.events.slice(-MAX_EVENTS); }
  private bumpRoots(): void { this.state!.rootGeneration = (this.state!.rootGeneration ?? 0) + 1; this.state!.binaryGcSweep = undefined; }
  private persist(): Promise<void> {
    // After idle-expiry reclaim, an in-flight request must not resurrect state.
    if (!this.state) throw new ControlError(410, "project_expired", "Project storage has been reclaimed after idle expiry");
    return this.ctx.storage.put(STATE_KEY, this.state);
  }
  private reject(status: number, error: string, message: string, extra?: object): Response { log("coordinator_rejected", { projectInstanceId: this.state?.projectInstanceId, error }); return fail(status, error, message, extra); }
}

function publicCatalog(s: CoordinatorState): CatalogV2 { const { protocol, projectInstanceId, name, lifecycle, catalogRevision, snapshotGeneration, workspaceLeaseGeneration, authorityEpoch, files } = s; return { protocol, projectInstanceId, ...(name ? { name } : {}), lifecycle, catalogRevision, snapshotGeneration, workspaceLeaseGeneration, authorityEpoch, files }; }
function requireLive(s: CoordinatorState): void { if (s.lifecycle !== "live") throw new ControlError(409, "project_not_live", "Project is not live"); }
function findFile(s: CoordinatorState, id: string): CatalogFileV2 { const file = s.files.find((f) => f.fileId === id); if (!file) throw new Error("File not found"); return file; }
function liveFile(s: CoordinatorState, id: string): CatalogFileV2 { const file = findFile(s, id); if (file.state !== "live" && file.state !== "initializing") throw new Error("File is not live"); return file; }
function ensurePathFree(s: CoordinatorState, path: string, except?: string): void { if (s.files.some((f) => f.fileId !== except && f.state !== "tombstoned" && f.state !== "purging" && f.path.toLocaleLowerCase("en-US") === path.toLocaleLowerCase("en-US"))) throw new Error("Path already exists or case-collides"); }
export function binaryKey(projectInstanceId: string, fileId: string, hash: string): string { return `v2/${projectInstanceId}/${fileId}/${hash}`; }
function canonicalPath(value: unknown): string { const path = requiredString(value, "path").normalize("NFC"); if (path.length > MAX_PATH || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) throw new Error("Invalid project-relative path"); const parts = path.split("/"); if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("Path traversal or empty segment"); return parts.join("/"); }
function requiredProjectName(value: unknown): string { const name = requiredString(value, "name").normalize("NFC").trim(); if (name.length > MAX_PROJECT_NAME || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid project name"); return name; }
function optionalProjectName(value: unknown): string | undefined { return value === undefined ? undefined : requiredProjectName(value); }
function parseImportManifest(value: unknown): ImportManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error("Invalid import manifest");
  const entries = value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid import manifest entry");
    const item = raw as Record<string, unknown>;
    const kind = item.kind;
    if (kind !== "text" && kind !== "binary" && kind !== "board" && kind !== "spreadsheet") throw new Error("Invalid import file kind");
    if (!isSha256(item.hash) || !isBinarySize(item.size)) throw new Error("Invalid import content identity");
    return { fileId: requiredString(item.fileId, "fileId"), path: canonicalPath(item.path), kind: kind as ImportManifestEntry["kind"], size: Number(item.size), hash: item.hash };
  });
  const identities = new Set(entries.map((entry) => entry.fileId));
  const paths = new Set(entries.map((entry) => entry.path.toLocaleLowerCase("en-US")));
  if (identities.size !== entries.length || paths.size !== entries.length) throw new Error("Import manifest has duplicate identity or case collision");
  return entries;
}
function requiredString(v: unknown, name: string): string { if (typeof v !== "string" || !v) throw new Error(`${name} is required`); return v; }
function requiredFileKind(v: unknown): CatalogFileV2["kind"] { if (v !== "text" && v !== "binary" && v !== "board" && v !== "spreadsheet") throw new Error("kind must be text, binary, board, or spreadsheet"); return v; }
function requiredInteger(v: unknown, name: string): number { if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error(`${name} must be a non-negative integer`); return Number(v); }
function strongSecret(v: unknown, name = "hostSecret"): string { const s = requiredString(v, name); if (new TextEncoder().encode(s).length < 32) throw new Error("Secret must have at least 256 bits of encoded entropy material"); return s; }
function secretHash(value: unknown): SecretHash {
  if (!value || typeof value !== "object") throw new Error("guestSecretHash is required");
  const candidate = value as Partial<SecretHash>;
  const salt = requiredString(candidate.salt, "guestSecretHash.salt");
  const hash = requiredString(candidate.hash, "guestSecretHash.hash");
  if (!/^[A-Za-z0-9_-]{43}$/.test(salt) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid guest secret hash");
  return { salt, hash };
}
function randomSecret(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function derive(secret: string): Promise<SecretHash> { const salt = randomSecret(); return { salt, hash: await digest(`${salt}:${secret}`) }; }
async function verify(secret: string, stored: SecretHash): Promise<boolean> { return constantTime(await digest(`${stored.salt}:${secret}`), stored.hash); }
async function digest(v: string): Promise<string> { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)); return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join(""); }
function constantTime(a: string, b: string): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function readObject(r: Request): Promise<Record<string, unknown>> { const value: unknown = await r.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required"); return value as Record<string, unknown>; }
function readObjectValue(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown>; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function fail(status: number, error: string, message: string, extra?: object): Response { return json({ error, message, ...extra }, status); }
function log(event: string, fields: object): void { console.info(JSON.stringify({ event, ...fields })); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: object) { super(message); }
}
function upsertWork(work: PendingFileWork[] | undefined, item: PendingFileWork): PendingFileWork[] {
  const result = work ?? [];
  if (!result.some((entry) => entry.kind === item.kind && entry.fileId === item.fileId && entry.documentEpoch === item.documentEpoch && (item.kind !== "revoke" || entry.grantId === item.grantId))) result.push(item);
  return result;
}
