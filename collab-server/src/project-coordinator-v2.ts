import { DurableObject } from "cloudflare:workers";
import { BINARY_OBJECT_VERSION, CONTROL_PROTOCOL_VERSION, isBinaryContentType, isBinarySize, isOperationId, isSha256, textFileV2RoomName, type BinaryConflictV2, type BinaryReadTicketClaimsV2, type BinaryReferenceV2, type BinaryUploadTicketClaimsV2, type CatalogFileV2, type OperationResultV2, type SocketTicketClaimsV2 } from "../../protocol/collab-v2";
import { canonicalJson, randomSecret, sha256Hex } from "../../protocol/encoding";
import { sweepBinaryObjects, type BinaryGcResult } from "./binary-gc";
import { activeFile, binaryKey, bumpRoots, canonicalPath, closeAck, ControlError, deriveSecretHash, ensurePathFree, fenceAck, findFile, foldPath, guestSecretHash, HOST_ACTOR, isActive, isTextSynced, MAX_FILES, MAX_PATH, MAX_TEXT_BYTES, objectValue, parseImportManifest, projectName, publicCatalog, readObject, requiredFileKind, requiredInteger, requiredString, requireLive, sameWork, strongSecret, upsertWork, verifySecret, type Actor, type BinaryRetentionRoot, type BinaryTicket, type Body, type CoordinatorState, type Grant, type PendingFileWork, type PresenceEntry, type WorkIdentity } from "./coordinator-model";
import { json, logEvent, retryDelay } from "./runtime";
import type { TextFileV2 } from "./text-file-v2";

const STATE_KEY = "coordinator:v2";
const DAY_MS = 24 * 60 * 60_000;
const MAX_GRANTS = 100;
const MAX_EVENTS = 256;
const MAX_OPERATIONS = 512;
const MAX_TICKETS_PER_MINUTE = 120;
const TICKET_TTL_MS = 60_000;
const MIN_GC_GRACE_MS = 60 * 60_000;
const MAX_RETENTION_TTL_MS = 90 * DAY_MS;
const TOMBSTONE_RETENTION_MS = 30 * DAY_MS;
/** Idle projects are fully reclaimed after this, matching the v1 room TTL. */
const PROJECT_IDLE_TTL_MS = 30 * DAY_MS;
/** Activity is rewritten to storage at most this often; the alarm only needs day-resolution freshness. */
const ACTIVITY_PERSIST_SLACK_MS = DAY_MS;
/** Presence heartbeats older than this are pruned on the next heartbeat from anyone. */
const PRESENCE_TTL_MS = 45_000;
const MAX_PRESENCE_ENTRIES = 100;
/** Catalog operations, by final path segment, that need more than read access. */
const HOST_OPERATIONS = new Set(["import-finalize", "file-ready", "delete-ack", "grants", "revoke", "project-rename", "close-begin", "close-ack"]);
const WRITE_OPERATIONS = new Set(["create", "rename", "delete-begin"]);

type Bindings = { TextFileV2: DurableObjectNamespace<TextFileV2>; BinaryObjects: R2Bucket };
/** What a catalog operation reports; outstanding ACKs make it "pending". */
type Outcome = { value?: unknown; pendingAcks?: string[] };

export class ProjectCoordinatorV2 extends DurableObject {
  private state: CoordinatorState | undefined;
  private readonly bindings: Bindings;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env as never);
    this.bindings = env;
    ctx.blockConcurrencyWhile(async () => { this.state = await ctx.storage.get(STATE_KEY); });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const [scope, action = ""] = [parts.at(-2), parts.at(-1)];
      if (request.method === "POST" && action === "bootstrap") return await this.bootstrap(request, parts[2] ?? "");
      const state = this.state;
      if (!state) return fail(404, "not_found", "Project has not been bootstrapped");
      const actor = await this.authenticate(request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1]);
      if (!actor) return this.reject(401, "auth", "Invalid or revoked credential");
      await this.touchActivity();
      // Handlers returned without `await` reject outside this try/catch, so the
      // errors they throw reach the Worker as a 500, not a 400. That is the
      // deployed wire behaviour for presence and the binary routes.
      const hostOnly = (handle: () => Response | Promise<Response>) => actor.permission === "host" ? handle() : this.reject(403, "forbidden", "Host permission required");
      if (request.method === "GET") {
        if (action === "catalog") return json(publicCatalog(state));
        if (action === "events") return this.events(url);
        if (action === "grants") return hostOnly(() => json(state.grants.map(({ grantId, permission, revoked, authEpoch }) => ({ grantId, permission, revoked, authEpoch }))));
        const fileId = url.searchParams.get("fileId");
        if (scope === "binary" && action === "conflicts") return json({ conflicts: (state.binaryConflicts ?? []).filter((item) => !fileId || item.fileId === fileId) });
        if (scope === "operations") return state.operations[action] ? json(state.operations[action].result) : fail(404, "operation_not_found", "Operation was not retained");
      }
      if (request.method !== "POST") return fail(405, "method", "Method not allowed");
      const body = await readObject(request);
      if (scope === "binary" && action === "upload-tickets") return this.issueBinaryUpload(body, actor);
      if (scope === "binary" && action === "read-tickets") return this.issueBinaryRead(body, actor);
      if (scope === "binary" && action === "commit") return this.commitBinary(body, actor);
      // The host trigger only advances the durable state machine; it cannot reduce production grace.
      if (scope === "binary" && action === "gc") return hostOnly(async () => json(await this.runBinaryGc(Date.now(), MIN_GC_GRACE_MS)));
      if (action === "presence") return this.updatePresence(body, actor);
      if ((action === "pin" || action === "release") && parts.at(-3) === "binary") return hostOnly(() => this.mutateRetentionRoot(action, scope!, body));
      return await this.mutate(action, body, actor);
    } catch (error) {
      if (error instanceof ControlError) return fail(error.status, error.code, error.message, error.extra);
      return fail(400, "invalid_request", error instanceof Error ? error.message : "Invalid request");
    }
  }

  private async bootstrap(request: Request, routedId: string): Promise<Response> {
    if (this.state) return fail(409, "already_exists", "Project already exists");
    const body = await readObject(request);
    const projectInstanceId = requiredString(body.projectInstanceId, "projectInstanceId");
    const name = body.projectName === undefined ? undefined : projectName(body.projectName);
    if (projectInstanceId !== decodeURIComponent(routedId)) throw new Error("projectInstanceId must match the routed coordinator");
    const hostSecret = strongSecret(body.hostSecret);
    const entries = body.importManifest === undefined ? [] : parseImportManifest(body.importManifest);
    if (entries.length && await sha256Hex(canonicalJson(entries)) !== body.expectedManifestHash) throw new Error("expectedManifestHash does not match canonical import manifest");
    const importPaths = body.paths ?? entries.map((entry) => entry.path);
    if (!Array.isArray(importPaths) || importPaths.length > MAX_FILES) throw new Error("Import file quota exceeded");
    const files: CatalogFileV2[] = importPaths.map((rawPath, index) => ({ fileId: entries[index]?.fileId ?? crypto.randomUUID(), path: canonicalPath(rawPath), kind: entries[index]?.kind ?? requiredFileKind(body.kind), state: "initializing", documentEpoch: 1 }));
    const folded = files.map((file) => foldPath(file.path));
    if (new Set(folded).size !== folded.length) throw new Error("Imported paths duplicate or case-collide");
    this.state = {
      protocol: CONTROL_PROTOCOL_VERSION, projectInstanceId, ...(name ? { name } : {}), lifecycle: "importing", catalogRevision: 0,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files, host: await deriveSecretHash(hostSecret),
      grants: [], operations: {}, operationOrder: [], events: [], tickets: [], ticketWindow: { startedAt: Date.now(), count: 0 },
      pendingCloseAcks: [], pendingFileWork: [], durableMetadata: {},
      binaryTickets: [], binaryReferences: {}, binaryConflicts: [], binaryRetentionRoots: [], rootGeneration: 0, binaryGcCandidates: {},
      lastActivityAt: Date.now(),
      ...(entries.length ? { import: { operationId: requiredString(body.operationId, "operationId"), expectedManifestHash: requiredString(body.expectedManifestHash, "expectedManifestHash"), entries, attempts: 0 } } : {}),
    };
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + MIN_GC_GRACE_MS);
    logEvent("project_bootstrapped", { projectInstanceId });
    return json(publicCatalog(this.state), 201);
  }

  private async authenticate(credential: string | undefined): Promise<Actor | null> {
    if (credential === undefined || !this.state) return null;
    if (await verifySecret(credential, this.state.host)) return HOST_ACTOR;
    for (const grant of this.state.grants) if (!grant.revoked && !grant.revoking && await verifySecret(credential, grant.secret)) return grant;
    return null;
  }

  /** Any authenticated use keeps the project alive past the idle TTL. Rewriting storage is throttled to once a day. */
  private async touchActivity(): Promise<void> {
    const state = this.state!;
    const now = Date.now();
    const previous = state.lastActivityAt ?? 0;
    state.lastActivityAt = now;
    if (now - previous > ACTIVITY_PERSIST_SLACK_MS) await this.persist();
  }

  /**
   * Project-level presence: per-file awareness rooms cannot see each other, so
   * clients heartbeat who they are and which file they are in. Entries expire
   * lazily — a crashed client disappears within PRESENCE_TTL_MS.
   */
  private async updatePresence(body: Body, actor: Actor): Promise<Response> {
    const instanceId = requiredString(body.instanceId, "instanceId");
    if (instanceId.length > 64) throw new Error("Invalid instanceId");
    const now = Date.now();
    const presence = this.state!.presence ??= {};
    for (const [id, entry] of Object.entries(presence)) if (now - entry.updatedAt > PRESENCE_TTL_MS) delete presence[id];
    const owner = presence[instanceId]?.grantId;
    if (body.leave === true) {
      if (actor.permission === "host" || owner === actor.grantId) delete presence[instanceId];
    } else {
      if (actor.permission !== "host" && owner && owner !== actor.grantId) return this.reject(403, "forbidden", "Presence entry belongs to another collaborator");
      if (!presence[instanceId] && Object.keys(presence).length >= MAX_PRESENCE_ENTRIES) return this.reject(429, "presence_full", "Too many presence entries");
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Anonymous";
      const color = typeof body.color === "string" && body.color ? body.color.slice(0, 40) : "#8b8b93";
      const path = typeof body.path === "string" && body.path ? body.path.slice(0, MAX_PATH) : null;
      presence[instanceId] = { name, color, path, updatedAt: now, grantId: actor.grantId, permission: actor.permission };
    }
    await this.persist();
    const visible = actor.permission === "host" ? presence : Object.fromEntries(Object.entries(presence).map(([id, { grantId: _grantId, ...entry }]) => [id, entry]));
    return json({ protocol: CONTROL_PROTOCOL_VERSION, presence: visible });
  }

  /** Idempotency log append with the bounded-retention prune in exactly one place. */
  private recordOperation(operationId: string, fingerprint: string, result: OperationResultV2): void {
    const state = this.state!;
    state.operations[operationId] = { fingerprint, result };
    state.operationOrder.push(operationId);
    while (state.operationOrder.length > MAX_OPERATIONS) delete state.operations[state.operationOrder.shift()!];
  }

  /** Idempotent compare-and-set catalog mutation: a replay returns the recorded result, a stale revision conflicts. */
  private async mutate(action: string, body: Body, actor: Actor): Promise<Response> {
    if (action === "tickets") return await this.issueSocketTicket(body, actor);
    if (HOST_OPERATIONS.has(action) && actor.permission !== "host") return this.reject(403, "forbidden", "Host permission required");
    if (WRITE_OPERATIONS.has(action) && actor.permission === "read") return this.reject(403, "forbidden", "Write permission required");
    const operationId = requiredString(body.operationId, "operationId");
    const fingerprint = await sha256Hex(canonicalJson({ action, body }));
    const state = this.state!;
    const old = state.operations[operationId];
    if (old) return old.fingerprint === fingerprint ? json(old.result) : fail(409, "operation_id_reuse", "Operation ID was used for a different request");
    if (requiredInteger(body.expectedCatalogRevision, "expectedCatalogRevision") !== state.catalogRevision) return this.reject(409, "catalog_revision_conflict", "Catalog revision does not match", { catalogRevision: state.catalogRevision });
    const { value, pendingAcks } = await this.applyOperation(action, body, actor, operationId);
    this.bump(action, typeof value === "object" && value && "fileId" in value ? String(value.fileId) : undefined);
    logEvent("coordinator_lifecycle", { projectInstanceId: state.projectInstanceId, action, catalogRevision: state.catalogRevision, backlog: pendingAcks?.length ?? 0 });
    this.recordOperation(operationId, fingerprint, { status: pendingAcks ? "pending" : "complete", catalogRevision: state.catalogRevision, value, pendingAcks, operationId });
    await this.persist();
    if (state.pendingFileWork?.length) await this.ctx.storage.setAlarm(Date.now() + 1);
    return json(state.operations[operationId].result);
  }

  private async applyOperation(action: string, body: Body, actor: Actor, operationId: string): Promise<Outcome> {
    const state = this.state!;
    switch (action) {
      case "import-finalize": this.finalizeImport(body); return {};
      case "project-rename": requireLive(state); state.name = projectName(body.name); return { value: { name: state.name } };
      case "create": return { value: this.createFile(body, actor) };
      case "rename": {
        requireLive(state);
        const file = activeFile(state, requiredString(body.fileId, "fileId"));
        const path = canonicalPath(body.path); ensurePathFree(state, path, file.fileId); file.path = path;
        return { value: file };
      }
      case "file-ready": {
        const file = findFile(state, requiredString(body.fileId, "fileId"));
        if (file.state !== "initializing") throw new Error("File is not initializing");
        if (isTextSynced(file.kind)) throw new Error("Text files require durable initialization");
        file.state = "live";
        return { value: file };
      }
      case "delete-begin": return this.beginDelete(body, operationId);
      case "delete-ack": {
        const file = findFile(state, requiredString(body.fileId, "fileId"));
        if (file.state !== "preparing-delete") throw new Error("File is not awaiting a fence");
        if (body.ack !== fenceAck(file)) throw new Error("Wrong file fence acknowledgement");
        this.tombstone(file);
        return { value: file };
      }
      case "grants": {
        if (state.lifecycle === "closing" || state.lifecycle === "closed") throw new Error("Project is closing");
        if (state.grants.length >= MAX_GRANTS) throw new Error("Grant quota exceeded");
        const permission = body.permission;
        if (permission !== "read" && permission !== "write") throw new Error("Invalid guest permission");
        const grant: Grant = { grantId: crypto.randomUUID(), permission, secret: guestSecretHash(body.guestSecretHash), revoked: false, authEpoch: 1 };
        state.grants.push(grant);
        return { value: { grantId: grant.grantId, permission } };
      }
      case "revoke": return this.revokeGuest(body, operationId);
      case "close-begin": return this.beginClose(operationId);
      case "close-ack": {
        if (state.lifecycle !== "closing") throw new Error("Project is not closing");
        const ack = requiredString(body.ack, "ack");
        if (!state.pendingCloseAcks.includes(ack)) throw new Error("Unknown or already received close acknowledgement");
        return { pendingAcks: this.settleClose(ack) };
      }
      default: throw new Error("Unknown operation");
    }
  }

  private finalizeImport(body: Body): void {
    const state = this.state!;
    if (state.lifecycle !== "importing") throw new Error("Project is not importing");
    const manifest = state.import;
    if (manifest) {
      manifest.attempts++;
      if (body.importOperationId !== manifest.operationId || body.expectedManifestHash !== manifest.expectedManifestHash) throw new Error("Import identity does not match bootstrap");
      const matches = manifest.entries.every((entry) => {
        const file = state.files.find((candidate) => candidate.fileId === entry.fileId);
        const content = entry.kind === "binary" ? state.binaryReferences?.[entry.fileId] : state.durableMetadata?.[entry.fileId];
        return file && content && file.path === entry.path && file.state === "live" && content.size === entry.size && content.hash === entry.hash;
      });
      if (!matches || state.files.length !== manifest.entries.length) {
        manifest.error = "catalog_or_content_manifest_mismatch";
        throw new ControlError(409, "import_manifest_mismatch", "Imported catalog/content does not exactly match the fenced source manifest");
      }
    }
    state.lifecycle = "live";
  }

  private createFile(body: Body, actor: Actor): CatalogFileV2 {
    const state = this.state!;
    requireLive(state);
    if (state.files.length >= MAX_FILES) throw new Error("File quota exceeded");
    const path = canonicalPath(body.path);
    ensurePathFree(state, path);
    const file: CatalogFileV2 = { fileId: crypto.randomUUID(), path, kind: requiredFileKind(body.kind), state: "initializing", documentEpoch: 1 };
    if (isTextSynced(file.kind)) {
      // The file goes live only once exactly these bytes are durable in its room (completeTextImport).
      const initializer = objectValue(body.initializer, "initializer must be an object");
      const operationId = requiredString(initializer.operationId, "initializer.operationId");
      const size = requiredInteger(initializer.size, "initializer.size");
      const hash = requiredString(initializer.hash, "initializer.hash");
      if (!isOperationId(operationId) || size > MAX_TEXT_BYTES || !isSha256(hash)) throw new Error("Invalid text initializer");
      (state.textInitializers ??= {})[file.fileId] = { grantId: actor.grantId, operationId, size, hash };
    }
    state.files.push(file);
    return file;
  }

  private async beginDelete(body: Body, operationId: string): Promise<Outcome> {
    const state = this.state!;
    requireLive(state);
    const file = activeFile(state, requiredString(body.fileId, "fileId"));
    file.state = "preparing-delete"; state.authorityEpoch++;
    const work: PendingFileWork = { kind: "delete", fileId: file.fileId, documentEpoch: file.documentEpoch, authorityEpoch: state.authorityEpoch, operationId };
    await this.persist();
    if (!isTextSynced(file.kind) || await this.tryDeliverWork(work, state, state.authorityEpoch)) { this.tombstone(file); return { value: file }; }
    state.pendingFileWork = upsertWork(state.pendingFileWork, work);
    return { value: file, pendingAcks: [fenceAck(file)] };
  }

  private async revokeGuest(body: Body, operationId: string): Promise<Outcome> {
    const state = this.state!;
    const grant = state.grants.find((item) => item.grantId === body.grantId);
    if (!grant) throw new Error("Grant not found");
    if (!grant.revoked && !grant.revoking) { grant.revoking = true; grant.authEpoch++; state.authorityEpoch++; }
    for (const [instanceId, entry] of Object.entries(state.presence ?? {})) if (entry.grantId === grant.grantId) delete state.presence![instanceId];
    await this.persist();
    const failed: string[] = [];
    for (const file of state.files.filter((item) => isTextSynced(item.kind) && isActive(item))) {
      const work: PendingFileWork = { kind: "revoke", fileId: file.fileId, documentEpoch: file.documentEpoch, authorityEpoch: state.authorityEpoch, operationId, grantId: grant.grantId, grantEpoch: grant.authEpoch };
      if (!await this.tryDeliverWork(work, state)) { failed.push(file.fileId); state.pendingFileWork = upsertWork(state.pendingFileWork, work); }
    }
    if (!failed.length) { grant.revoked = true; grant.revoking = false; }
    return { value: { grantId: grant.grantId, authEpoch: grant.authEpoch }, pendingAcks: failed.length ? failed.map((id) => `grant-revoke:${id}:${grant.authEpoch}`) : undefined };
  }

  private async beginClose(operationId: string): Promise<Outcome> {
    const state = this.state!;
    if (state.lifecycle !== "live") throw new Error("Project is not live");
    state.lifecycle = "closing"; state.authorityEpoch++;
    const active = state.files.filter(isActive);
    state.pendingCloseAcks = active.map((file) => closeAck(file.fileId, file.documentEpoch));
    state.pendingFileWork = active.reduce((work, file) => upsertWork(work, { kind: "close", fileId: file.fileId, documentEpoch: file.documentEpoch, authorityEpoch: state.authorityEpoch, operationId }), state.pendingFileWork ?? []);
    await this.persist();
    for (const work of state.pendingFileWork.filter((item) => item.kind === "close")) {
      const file = state.files.find((item) => item.fileId === work.fileId);
      if (file?.kind !== "binary" && !await this.tryDeliverWork(work, state, state.authorityEpoch)) continue;
      state.pendingCloseAcks = state.pendingCloseAcks.filter((ack) => ack !== closeAck(work.fileId, work.documentEpoch));
      state.pendingFileWork = state.pendingFileWork.filter((item) => item !== work);
    }
    return { pendingAcks: this.settleClose() };
  }

  /** Drops `ack` if given. With no close ACK left the project closes and every grant is retired; otherwise returns the outstanding ACKs. */
  private settleClose(ack?: string): string[] | undefined {
    const state = this.state!;
    if (ack) state.pendingCloseAcks = state.pendingCloseAcks.filter((item) => item !== ack);
    if (state.pendingCloseAcks.length) return state.pendingCloseAcks;
    state.lifecycle = "closed";
    state.grants.forEach((grant) => { grant.revoked = true; });
    return undefined;
  }

  /**
   * A tombstoned binary's R2 object moves from the live references into a
   * 30-day retention root: the GC keeps it recoverable for a grace period,
   * then reclaims it. Without this the reference leaks forever (the GC treats
   * it as a live root and the object is never deleted).
   */
  private tombstone(file: CatalogFileV2): void {
    const state = this.state!;
    file.state = "tombstoned";
    const reference = state.binaryReferences?.[file.fileId];
    if (!reference) return;
    (state.binaryRetentionRoots ??= []).push({ rootId: crypto.randomUUID(), kind: "tombstone", key: binaryKey(state.projectInstanceId, file.fileId, reference.hash), expiresAt: Date.now() + TOMBSTONE_RETENTION_MS, operationId: `delete:${file.fileId}:${file.documentEpoch}` });
    delete state.binaryReferences![file.fileId];
    bumpRoots(state);
  }

  private textFile(projectInstanceId: string, fileId: string, documentEpoch: number): DurableObjectStub<TextFileV2> {
    return this.bindings.TextFileV2.getByName(textFileV2RoomName(projectInstanceId, fileId, documentEpoch));
  }

  /** Pushes one fence or revocation to its file's room; resolves `true` once the room has applied it. */
  private async deliverWork(work: PendingFileWork, { projectInstanceId }: CoordinatorState, authorityEpoch = work.authorityEpoch): Promise<boolean> {
    const room = this.textFile(projectInstanceId, work.fileId, work.documentEpoch);
    if (work.kind === "delete") return await room.fenceForDeletion(projectInstanceId, work.fileId, work.documentEpoch, authorityEpoch);
    if (work.kind === "close") return await room.fenceForProjectClose(projectInstanceId, work.fileId, work.documentEpoch, authorityEpoch);
    return await room.revokeGrant(work.grantId!, work.grantEpoch!, authorityEpoch);
  }

  /** Inline delivery during an operation: any failure leaves the work pending for the alarm to retry. */
  private tryDeliverWork(work: PendingFileWork, state: CoordinatorState, authorityEpoch?: number): Promise<boolean> {
    return this.deliverWork(work, state, authorityEpoch).catch(() => false);
  }

  private async issueSocketTicket(body: Body, actor: Actor): Promise<Response> {
    const state = this.state!;
    requireLive(state);
    const now = Date.now();
    if (now - state.ticketWindow.startedAt >= 60_000) state.ticketWindow = { startedAt: now, count: 0 };
    if (++state.ticketWindow.count > MAX_TICKETS_PER_MINUTE) return fail(429, "ticket_quota", "Ticket issuance quota exceeded");
    const audience = body.audience;
    if (audience !== "project" && audience !== "file") throw new Error("Invalid ticket audience");
    const file = audience === "file" ? activeFile(state, requiredString(body.fileId, "fileId")) : undefined;
    if (file && !isTextSynced(file.kind)) throw new Error("Text socket tickets require a text-synced file");
    const token = randomSecret();
    const claims: SocketTicketClaimsV2 = { protocol: 2, projectInstanceId: state.projectInstanceId, audience, fileId: file?.fileId, documentEpoch: file?.documentEpoch, grantId: actor.grantId, permission: actor.permission, grantEpoch: actor.authEpoch, projectAuthorityEpoch: state.authorityEpoch, expiresAt: now + TICKET_TTL_MS };
    state.tickets.push({ tokenHash: await sha256Hex(token), claims, consumed: false });
    state.tickets = state.tickets.filter((ticket) => !ticket.consumed && ticket.claims.expiresAt > now).slice(-MAX_TICKETS_PER_MINUTE * 2);
    await this.persist();
    return json({ ticket: token, claims });
  }

  async consumeSocketTicket(ticket: string, audience: "project" | "file", fileId?: string, documentEpoch?: number): Promise<SocketTicketClaimsV2 | null> {
    if (!this.state) return null;
    const hash = await sha256Hex(ticket);
    const found = this.state.tickets.find((item) => item.tokenHash === hash);
    if (!found || found.consumed || found.claims.expiresAt <= Date.now() || found.claims.projectInstanceId !== this.state.projectInstanceId || found.claims.audience !== audience) return null;
    if (audience === "file") {
      if (found.claims.fileId !== fileId || (documentEpoch !== undefined && found.claims.documentEpoch !== documentEpoch)) return null;
      const file = this.state.files.find((item) => item.fileId === found.claims.fileId);
      if (!file || file.state !== "live" || file.documentEpoch !== found.claims.documentEpoch) return null;
    }
    const grant = found.claims.grantId === "host" ? null : this.state.grants.find((item) => item.grantId === found.claims.grantId);
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

  private async issueBinaryUpload(body: Body, actor: Actor): Promise<Response> {
    const state = this.state!;
    const importing = state.lifecycle === "importing" && actor.permission === "host" && body.import === true;
    if (!importing) requireLive(state);
    if (actor.permission === "read") return this.reject(403, "forbidden", "Write permission required");
    const file = activeFile(state, requiredString(body.fileId, "fileId"));
    if (isTextSynced(file.kind)) throw new Error("Binary uploads require a binary file");
    const documentEpoch = requiredInteger(body.documentEpoch, "documentEpoch");
    if (file.documentEpoch !== documentEpoch) return this.reject(409, "stale_epoch", "Document epoch does not match");
    const { declaredHash, declaredSize, contentType, operationId, expectedPriorHash: prior } = body;
    if (!isSha256(declaredHash) || !isBinarySize(declaredSize) || !isBinaryContentType(contentType) || !isOperationId(operationId)) throw new Error("Invalid binary upload claims");
    if (importing) {
      const entry = state.import?.entries.find((item) => item.fileId === file.fileId);
      if (!entry || entry.kind !== "binary" || entry.hash !== declaredHash || entry.size !== declaredSize || file.state !== "initializing") return this.reject(409, "import_manifest_mismatch", "Binary import does not match manifest");
    }
    const expectedCatalogRevision = requiredInteger(body.expectedCatalogRevision, "expectedCatalogRevision");
    const expectedContentRevision = requiredInteger(body.expectedContentRevision, "expectedContentRevision");
    if (prior !== undefined && !isSha256(prior)) throw new Error("Invalid expectedPriorHash");
    const claims: BinaryUploadTicketClaimsV2 = { protocol: 2, kind: "binary-upload", projectInstanceId: state.projectInstanceId, fileId: file.fileId, documentEpoch, grantId: actor.grantId, permission: actor.permission, grantEpoch: actor.authEpoch, projectAuthorityEpoch: state.authorityEpoch, expectedCatalogRevision, expectedContentRevision, ...(prior ? { expectedPriorHash: prior } : {}), declaredHash, declaredSize, contentType, operationId, expiresAt: Date.now() + TICKET_TTL_MS };
    return json({ ticket: await this.storeBinaryTicket(claims), expiresAt: claims.expiresAt });
  }

  private async issueBinaryRead(body: Body, actor: Actor): Promise<Response> {
    const state = this.state!;
    requireLive(state);
    const file = activeFile(state, requiredString(body.fileId, "fileId"));
    if (isTextSynced(file.kind)) throw new Error("Binary downloads require a binary file");
    if (file.documentEpoch !== requiredInteger(body.documentEpoch, "documentEpoch")) return this.reject(409, "stale_epoch", "Document epoch does not match");
    const conflictId = body.conflictId === undefined ? undefined : requiredString(body.conflictId, "conflictId");
    const reference = conflictId ? state.binaryConflicts?.find((item) => item.conflictId === conflictId && item.fileId === file.fileId)?.loser : state.binaryReferences?.[file.fileId];
    if (!reference) return this.reject(404, "binary_not_found", "Binary version not found");
    const { hash, size, contentType } = reference;
    const claims: BinaryReadTicketClaimsV2 = { protocol: 2, kind: "binary-read", projectInstanceId: state.projectInstanceId, fileId: file.fileId, documentEpoch: file.documentEpoch, grantId: actor.grantId, grantEpoch: actor.authEpoch, projectAuthorityEpoch: state.authorityEpoch, hash, size, contentType, ...(conflictId ? { conflictId } : {}), expiresAt: Date.now() + TICKET_TTL_MS };
    return json({ ticket: await this.storeBinaryTicket(claims), hash, size, contentType, expiresAt: claims.expiresAt });
  }

  /** Upload and read tickets share one store, trimmed on every issue so repeated downloads cannot grow the DO state. */
  private async storeBinaryTicket(claims: BinaryTicket["claims"]): Promise<string> {
    const state = this.state!;
    const token = randomSecret();
    const now = Date.now();
    state.binaryTickets = (state.binaryTickets ?? []).filter((item) => item.claims.expiresAt > now && !item.failed).slice(-MAX_TICKETS_PER_MINUTE * 2);
    state.binaryTickets.push({ tokenHash: await sha256Hex(token), claims, createdAt: now, consumed: false });
    await this.persist();
    return token;
  }

  /** Trusted Worker seam. Consumes the ticket before bytes are accepted. */
  async consumeBinaryUploadTicket(token: string): Promise<BinaryUploadTicketClaimsV2 | null> { return await this.consumeBinaryTicket(token, "binary-upload") as BinaryUploadTicketClaimsV2 | null; }
  async consumeBinaryReadTicket(token: string): Promise<BinaryReadTicketClaimsV2 | null> { return await this.consumeBinaryTicket(token, "binary-read") as BinaryReadTicketClaimsV2 | null; }

  private async consumeBinaryTicket(token: string, kind: BinaryTicket["claims"]["kind"]): Promise<BinaryTicket["claims"] | null> {
    if (!this.state || (this.state.lifecycle !== "live" && this.state.lifecycle !== "importing")) return null;
    const hash = await sha256Hex(token);
    const ticket = this.state.binaryTickets?.find((entry) => entry.tokenHash === hash);
    if (!ticket || ticket.consumed || ticket.claims.kind !== kind || ticket.claims.expiresAt <= Date.now() || !this.ticketAuthorityValid(ticket)) return null;
    ticket.consumed = true; await this.persist(); return ticket.claims;
  }

  async markBinaryUploaded(token: string, claims: BinaryUploadTicketClaimsV2, key: string): Promise<boolean> {
    const hash = await sha256Hex(token);
    const item = this.state?.binaryTickets?.find((ticket) => ticket.tokenHash === hash);
    if (!item || item.claims.kind !== "binary-upload" || !item.consumed || item.failed || item.claims.expiresAt <= Date.now()) return false;
    if (canonicalJson(item.claims) !== canonicalJson(claims) || key !== binaryKey(claims.projectInstanceId, claims.fileId, claims.declaredHash) || !this.ticketAuthorityValid(item)) return false;
    item.uploaded = true; item.verifiedKey = key; bumpRoots(this.state!); await this.persist(); return true;
  }

  /** Binary writes need a live file, except the host's import uploads into still-initializing files. */
  private acceptsBinaryWrite(file: CatalogFileV2, grantId: string): boolean {
    return file.state === "live" || (this.state!.lifecycle === "importing" && grantId === "host" && file.state === "initializing");
  }

  /** A binary ticket stays usable only while its file, epoch, project authority and grant are all unchanged. */
  private ticketAuthorityValid(ticket: BinaryTicket): boolean {
    const state = this.state;
    if (!state || (state.lifecycle !== "live" && state.lifecycle !== "importing") || ticket.claims.projectInstanceId !== state.projectInstanceId) return false;
    const { fileId, documentEpoch, grantId, grantEpoch, projectAuthorityEpoch } = ticket.claims;
    const file = state.files.find((entry) => entry.fileId === fileId);
    if (!file || !this.acceptsBinaryWrite(file, grantId) || file.documentEpoch !== documentEpoch || projectAuthorityEpoch !== state.authorityEpoch) return false;
    const grant = state.grants.find((entry) => entry.grantId === grantId);
    return grantId === "host" || (!!grant && !grant.revoked && !grant.revoking && grant.authEpoch === grantEpoch);
  }

  private async commitBinary(body: Body, actor: Actor): Promise<Response> {
    // Re-read this.state after every await: an idle-expiry reclaim can clear it meanwhile.
    const hash = await sha256Hex(requiredString(body.ticket, "ticket"));
    const ticket = this.state!.binaryTickets?.find((item) => item.tokenHash === hash);
    if (!ticket || ticket.claims.kind !== "binary-upload" || !ticket.uploaded || ticket.failed || ticket.claims.grantId !== actor.grantId || ticket.claims.expiresAt <= Date.now() || !this.ticketAuthorityValid(ticket)) return this.reject(403, "invalid_ticket", "Upload ticket is not committed and verified");
    const claims = ticket.claims;
    const operationId = requiredString(body.operationId, "operationId");
    if (operationId !== claims.operationId) throw new Error("operationId does not match ticket");
    const old = this.state!.operations[operationId];
    const fingerprint = await sha256Hex(canonicalJson({ action: "binary-commit", claims }));
    if (old) return old.fingerprint === fingerprint ? json(old.result.value) : fail(409, "operation_id_reuse", "Operation ID was used for different binary claims");
    if (this.state!.lifecycle !== "importing") requireLive(this.state!);
    const file = this.state!.files.find((entry) => entry.fileId === claims.fileId);
    if (!file || !this.acceptsBinaryWrite(file, claims.grantId) || file.documentEpoch !== claims.documentEpoch) return this.reject(409, "stale_file", "File is no longer writable");
    const head = await this.bindings.BinaryObjects.head(binaryKey(claims.projectInstanceId, claims.fileId, claims.declaredHash));
    if (!head || head.size !== claims.declaredSize || head.customMetadata?.sha256 !== claims.declaredHash || head.customMetadata?.version !== BINARY_OBJECT_VERSION) return this.reject(409, "object_unverified", "Verified binary object is unavailable");
    const state = this.state!;
    const current = state.binaryReferences?.[claims.fileId];
    const reference: BinaryReferenceV2 = { fileId: claims.fileId, documentEpoch: claims.documentEpoch, contentRevision: (current?.contentRevision ?? file.contentRevision ?? 0) + 1, hash: claims.declaredHash, size: claims.declaredSize, contentType: claims.contentType };
    let value: unknown;
    if ((current?.contentRevision ?? 0) !== claims.expectedContentRevision || current?.hash !== claims.expectedPriorHash) {
      // A lost race keeps both objects: the loser becomes a conflict (and a GC root) instead of overwriting.
      const conflict: BinaryConflictV2 = { conflictId: crypto.randomUUID(), fileId: claims.fileId, createdAt: Date.now(), ...(current ? { winner: current } : {}), loser: reference };
      (state.binaryConflicts ??= []).push(conflict);
      value = { status: "conflict", current, conflict };
    } else {
      (state.binaryReferences ??= {})[claims.fileId] = reference;
      file.contentRevision = reference.contentRevision; file.hash = reference.hash; file.size = reference.size;
      if (state.lifecycle === "importing") file.state = "live";
      this.bump("binary-commit", file.fileId);
      value = { status: "complete", current: reference };
    }
    bumpRoots(state);
    this.recordOperation(operationId, fingerprint, { operationId, status: "complete", catalogRevision: state.catalogRevision, value });
    await this.persist();
    return json(value);
  }

  private async mutateRetentionRoot(action: "pin" | "release", kind: string, body: Body): Promise<Response> {
    if (kind !== "offline-recovery" && kind !== "migration-snapshot") throw new Error("Invalid retention root kind");
    const state = this.state!;
    const operationId = requiredString(body.operationId, "operationId");
    const roots = state.binaryRetentionRoots ??= [];
    const existing = roots.find((root) => root.operationId === operationId);
    if (existing) return json(existing);
    if (action === "release") {
      const rootId = requiredString(body.rootId, "rootId");
      state.binaryRetentionRoots = roots.filter((root) => root.rootId !== rootId || root.kind !== kind);
      bumpRoots(state); await this.persist();
      return json({ rootId, released: true });
    }
    const fileId = requiredString(body.fileId, "fileId");
    const hash = requiredString(body.hash, "hash");
    if (!isSha256(hash)) throw new Error("Invalid hash");
    const ttlMs = Math.min(MAX_RETENTION_TTL_MS, requiredInteger(body.ttlMs, "ttlMs"));
    if (ttlMs <= 0) throw new Error("ttlMs must be positive");
    const root: BinaryRetentionRoot = { rootId: crypto.randomUUID(), kind, key: binaryKey(state.projectInstanceId, fileId, hash), expiresAt: Date.now() + ttlMs, operationId };
    roots.push(root); bumpRoots(state); await this.persist();
    return json(root);
  }

  private runBinaryGc(now: number, graceMs: number): Promise<BinaryGcResult> {
    const scheduleRetry = async (attempts: number) => { await this.ctx.storage.setAlarm(Date.now() + retryDelay(attempts)); };
    return sweepBinaryObjects(this.state!, { bucket: this.bindings.BinaryObjects, persist: () => this.persist(), scheduleRetry }, now, graceMs);
  }

  /** Internal DO test seam; production and tests execute the same persisted sweep implementation. */
  async runBinaryGcForTest(now: number, minGraceMs = MIN_GC_GRACE_MS): Promise<BinaryGcResult> { return this.runBinaryGc(now, minGraceMs); }

  /** Test seam: rewinds the idle clock through the in-memory state so nothing shadows it. */
  async setLastActivityForTest(at: number): Promise<void> {
    if (!this.state) throw new Error("Project has not been bootstrapped");
    this.state.lastActivityAt = at; await this.persist();
  }

  /** Test seam: fills the idempotency log to exercise its bounded retention. */
  async seedOperationsForTest(count: number): Promise<void> {
    for (let index = 0; index < count; index++) this.recordOperation(`seed-${index}`, "seed", { operationId: `seed-${index}`, status: "complete", catalogRevision: 0 });
    await this.persist();
  }

  /** Test seam: backdates a presence entry to exercise lazy expiry. */
  async seedPresenceForTest(instanceId: string, entry: PresenceEntry): Promise<void> { (this.state!.presence ??= {})[instanceId] = entry; await this.persist(); }

  /**
   * Idle-TTL reclaim (v1 room-TTL parity): wipe every text file DO, every R2
   * object under the project prefix, then the coordinator itself. Each step is
   * idempotent; a failure keeps the coordinator alive so the next alarm retries
   * instead of stranding half-wiped data with no state left to find it.
   */
  private async expireProject(): Promise<void> {
    const { projectInstanceId, files } = this.state!;
    logEvent("project_idle_expired", { projectInstanceId });
    let failed = false;
    for (const file of files) {
      try { await this.textFile(projectInstanceId, file.fileId, file.documentEpoch).destroyForExpiry(projectInstanceId, file.fileId, file.documentEpoch); }
      catch (error) { failed = true; logEvent("project_expiry_file_failed", { projectInstanceId, fileId: file.fileId, error: String(error) }, "warn"); }
    }
    try {
      let cursor: string | undefined;
      do {
        const page = await this.bindings.BinaryObjects.list({ prefix: `v2/${projectInstanceId}/`, cursor, limit: 500 });
        for (const object of page.objects) await this.bindings.BinaryObjects.delete(object.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch (error) { failed = true; logEvent("project_expiry_r2_failed", { projectInstanceId, error: String(error) }, "warn"); }
    if (failed) { await this.ctx.storage.setAlarm(Date.now() + 60_000); return; }
    // Drop the reference before deleteAll so an interleaved request fails on
    // the persist() guard instead of resurrecting reclaimed state.
    this.state = undefined;
    await this.ctx.storage.deleteAll();
  }

  /** Trusted Worker seam: authorize bootstrap imports or a writer's newly-created text initializer. */
  async authorizeTextImport(credential: string, fileId: string, documentEpoch: number, operationId: string, size: number, hash: string): Promise<boolean> {
    if (!this.state || !isOperationId(operationId) || !isSha256(hash)) return false;
    const file = this.state.files.find((item) => item.fileId === fileId);
    const metadata = this.state.durableMetadata?.[fileId];
    const replay = file?.state === "live" && metadata?.size === size && metadata.hash === hash;
    if (!file || (file.state !== "initializing" && !replay) || file.documentEpoch !== documentEpoch || !isTextSynced(file.kind)) return false;
    if (this.state.lifecycle === "live") {
      const actor = await this.authenticate(credential);
      const initializer = this.state.textInitializers?.[fileId];
      return !!actor && actor.permission !== "read" && !!initializer && actor.grantId === initializer.grantId && operationId === initializer.operationId && size === initializer.size && hash === initializer.hash;
    }
    if (this.state.lifecycle !== "importing" || !await verifySecret(credential, this.state.host)) return false;
    return this.importDeclares(fileId, size, hash);
  }

  async completeTextImport(fileId: string, documentEpoch: number, size: number, hash: string): Promise<boolean> {
    const state = this.state;
    if (!state || (state.lifecycle !== "importing" && state.lifecycle !== "live")) return false;
    const file = state.files.find((item) => item.fileId === fileId);
    const metadata = state.durableMetadata?.[fileId];
    if (!file || file.documentEpoch !== documentEpoch || !isTextSynced(file.kind)) return false;
    if (file.state === "live") return metadata?.size === size && metadata.hash === hash;
    if (file.state !== "initializing" || (state.lifecycle === "importing" && !this.importDeclares(fileId, size, hash))) return false;
    const initializer = state.textInitializers?.[fileId];
    if ((state.lifecycle === "live" && (!initializer || initializer.size !== size || initializer.hash !== hash)) || !metadata) return false;
    if (initializer) initializer.completed = true;
    metadata.size = size; metadata.hash = hash; file.size = size; file.hash = hash; file.state = "live";
    this.bump("file-ready", fileId); await this.persist(); return true;
  }

  private importDeclares(fileId: string, size: number, hash: string): boolean {
    const entry = this.state!.import?.entries.find((item) => item.fileId === fileId);
    return !!entry && isTextSynced(entry.kind) && entry.size === size && entry.hash === hash;
  }

  /** Trusted DO-to-DO seam: callers must already hold this coordinator stub. */
  async acknowledgeFileReady(fileId: string, documentEpoch: number): Promise<boolean> {
    const file = this.state?.files.find((item) => item.fileId === fileId);
    if (!file || file.documentEpoch !== documentEpoch || file.state !== "initializing") return false;
    file.state = "live"; this.bump("file-ready", fileId); await this.persist(); return true;
  }

  /** Trusted DO-to-DO seam: exact IDs and epochs prevent stale File DO acknowledgements. */
  async acknowledgeFileDeleted(fileId: string, documentEpoch: number): Promise<boolean> {
    const file = this.state?.files.find((item) => item.fileId === fileId);
    if (!file || file.documentEpoch !== documentEpoch || file.state !== "tombstoned") return false;
    await this.removeWork({ kind: "delete", fileId, documentEpoch }); return true;
  }

  async acknowledgeFileClosed(fileId: string, documentEpoch: number): Promise<boolean> {
    const state = this.state;
    if (!state) return false;
    const ack = closeAck(fileId, documentEpoch);
    const work: WorkIdentity = { kind: "close", fileId, documentEpoch };
    const file = state.files.find((item) => item.fileId === fileId);
    // A repeated ACK for a file whose close already settled is idempotently accepted.
    if ((state.lifecycle === "closing" || state.lifecycle === "closed") && file?.documentEpoch === documentEpoch
      && !state.pendingCloseAcks.includes(ack) && !state.pendingFileWork?.some((item) => sameWork(item, work))) return true;
    if (state.lifecycle !== "closing" || !state.pendingCloseAcks.includes(ack)) return false;
    this.settleClose(ack);
    state.pendingFileWork = state.pendingFileWork?.filter((item) => !sameWork(item, work));
    this.bump("close-ack", fileId); await this.persist(); return true;
  }

  /** Cache only: TextFileV2 remains the authority deciding which Yjs updates are accepted. */
  async updateTextDurableMetadata(fileId: string, documentEpoch: number, contentRevision: number, snapshotGeneration: number, size: number, hash: string, stateVector: string): Promise<boolean> {
    const state = this.state;
    if (!state || (state.lifecycle !== "live" && state.lifecycle !== "importing")) return false;
    const file = state.files.find((item) => item.fileId === fileId);
    if (!file || !isActive(file) || file.documentEpoch !== documentEpoch) return false;
    const previous = state.durableMetadata?.[fileId];
    if (previous && contentRevision < previous.contentRevision) return false;
    if (previous && contentRevision === previous.contentRevision) return previous.snapshotGeneration === snapshotGeneration && previous.hash === hash;
    (state.durableMetadata ??= {})[fileId] = { documentEpoch, contentRevision, snapshotGeneration, size, hash, stateVector };
    file.contentRevision = contentRevision; file.size = size; file.hash = hash;
    await this.persist(); return true;
  }

  /** Idle expiry first; then the oldest pending file work, retried with backoff; otherwise the periodic binary GC. */
  override async alarm(): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (state.lastActivityAt === undefined) {
      // Projects bootstrapped before the idle TTL existed start their clock now.
      state.lastActivityAt = Date.now(); await this.persist();
    } else if (Date.now() - state.lastActivityAt > PROJECT_IDLE_TTL_MS) {
      await this.expireProject(); return;
    }
    const work = state.pendingFileWork?.[0];
    if (!work) {
      try { await this.runBinaryGc(Date.now(), MIN_GC_GRACE_MS); } catch (error) { logEvent("binary_gc_retry", { projectInstanceId: state.projectInstanceId, error: String(error) }, "warn"); }
      // A failed sweep schedules its own short retry backoff; only arm the
      // long-period sweep if nothing sooner is pending.
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > Date.now() + MIN_GC_GRACE_MS) await this.ctx.storage.setAlarm(Date.now() + MIN_GC_GRACE_MS);
      return;
    }
    work.attempts = (work.attempts ?? 0) + 1; work.lastAttemptAt = Date.now();
    await this.persist();
    const file = state.files.find((item) => item.fileId === work.fileId && item.documentEpoch === work.documentEpoch);
    try {
      if (!file || !await this.deliverWork(work, state)) return;
      if (work.kind === "delete") {
        if (file.state === "preparing-delete") this.tombstone(file);
        await this.removeWork(work); this.completePendingOperation(work.operationId); await this.persist();
      } else if (work.kind === "close") {
        await this.acknowledgeFileClosed(work.fileId, work.documentEpoch);
        if (state.lifecycle === "closed") { this.completePendingOperation(work.operationId); await this.persist(); }
      } else {
        await this.removeWork(work);
        const grant = state.grants.find((item) => item.grantId === work.grantId);
        if (!state.pendingFileWork?.some((item) => item.kind === "revoke" && item.grantId === work.grantId) && grant?.revoking && grant.authEpoch === work.grantEpoch) {
          grant.revoked = true; grant.revoking = false; this.completePendingOperation(work.operationId); await this.persist();
        }
      }
    } finally {
      const pending = state.pendingFileWork?.[0];
      if (pending) {
        const retryInMs = retryDelay(pending.attempts ?? 1);
        logEvent("coordinator_file_work_backlog", { projectInstanceId: state.projectInstanceId, kind: pending.kind, fileId: pending.fileId, documentEpoch: pending.documentEpoch, attempts: pending.attempts, retryInMs }, "warn");
        await this.ctx.storage.setAlarm(Date.now() + retryInMs);
      }
    }
  }

  private async removeWork(target: WorkIdentity): Promise<void> {
    if (!this.state) return;
    this.state.pendingFileWork = this.state.pendingFileWork?.filter((work) => !sameWork(work, target));
    await this.persist();
  }

  private completePendingOperation(operationId?: string): void {
    const operation = operationId ? this.state?.operations[operationId] : undefined;
    if (operation?.result.status === "pending") operation.result = { ...operation.result, status: "complete", catalogRevision: this.state!.catalogRevision, pendingAcks: undefined };
  }

  private events(url: URL): Response {
    const { catalogRevision, events } = this.state!;
    const since = Number(url.searchParams.get("since") ?? catalogRevision);
    const first = events[0]?.catalogRevision ?? catalogRevision + 1;
    if (!Number.isSafeInteger(since) || since < first - 1) return fail(409, "event_gap", "Retained events do not cover requested revision", { catalogRevision, refetch: true });
    return json({ catalogRevision, events: events.filter((event) => event.catalogRevision > since), refetch: false });
  }

  private bump(type: string, fileId?: string): void {
    const state = this.state!;
    state.catalogRevision++;
    state.events.push({ catalogRevision: state.catalogRevision, type, fileId });
    state.events = state.events.slice(-MAX_EVENTS);
  }

  private persist(): Promise<void> {
    // After idle-expiry reclaim, an in-flight request must not resurrect state.
    if (!this.state) throw new ControlError(410, "project_expired", "Project storage has been reclaimed after idle expiry");
    return this.ctx.storage.put(STATE_KEY, this.state);
  }

  private reject(status: number, error: string, message: string, extra?: object): Response {
    logEvent("coordinator_rejected", { projectInstanceId: this.state?.projectInstanceId, error });
    return fail(status, error, message, extra);
  }
}

function fail(status: number, error: string, message: string, extra?: object): Response { return json({ error, message, ...extra }, status); }
