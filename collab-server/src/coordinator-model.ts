import { isBinarySize, isSha256, type BinaryConflictV2, type BinaryReadTicketClaimsV2, type BinaryReferenceV2, type BinaryUploadTicketClaimsV2, type CatalogFileV2, type CatalogV2, type CoordinatorEventV2, type GrantPermission, type OperationResultV2, type SocketTicketClaimsV2 } from "../../protocol/collab-v2";
import { randomSecret, sha256Hex } from "../../protocol/encoding";

export const MAX_FILES = 2_000;
export const MAX_PATH = 512;
/** Largest initial text a create may declare; the Worker bounds the import upload by the same limit. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

// The coordinator persists one CoordinatorState record, so these shapes are a storage format.
// Optional fields can be absent from older or freshly bootstrapped records and are created on first use.
export type SecretHash = { salt: string; hash: string };
export type Grant = { grantId: string; permission: GrantPermission; secret: SecretHash; revoked: boolean; revoking?: boolean; authEpoch: number };
type StoredTicket = { tokenHash: string; claims: SocketTicketClaimsV2; consumed: boolean };
export type BinaryTicket = { tokenHash: string; claims: BinaryUploadTicketClaimsV2 | BinaryReadTicketClaimsV2; createdAt: number; consumed: boolean; uploaded?: boolean; failed?: boolean; verifiedKey?: string };
export type BinaryRetentionRoot = { rootId: string; kind: "tombstone" | "offline-recovery" | "migration-snapshot"; key: string; expiresAt: number; operationId: string };
export type PendingFileWork = { kind: "delete" | "close" | "revoke"; fileId: string; documentEpoch: number; authorityEpoch: number; operationId?: string; grantId?: string; grantEpoch?: number; attempts?: number; lastAttemptAt?: number };
type DurableMetadata = { documentEpoch: number; contentRevision: number; snapshotGeneration: number; size: number; hash: string; stateVector: string };
type ImportManifestEntry = { fileId: string; path: string; kind: CatalogFileV2["kind"]; size: number; hash: string };
/**
 * `permission` is stamped from the authenticated actor, never from the request
 * body: "who started this share" is the one presence field a client must not be
 * able to claim for itself. Unlike `grantId` it stays visible to every peer, so
 * guests can tell the host apart from each other in the collaborator list.
 */
export type PresenceEntry = { name: string; color: string; path: string | null; updatedAt: number; grantId?: string; permission?: GrantPermission };
export type CoordinatorState = CatalogV2 & {
  host: SecretHash;
  grants: Grant[];
  operations: Record<string, { fingerprint: string; result: OperationResultV2 }>;
  operationOrder: string[];
  events: CoordinatorEventV2[];
  tickets: StoredTicket[];
  ticketWindow: { startedAt: number; count: number };
  pendingCloseAcks: string[];
  pendingFileWork?: PendingFileWork[];
  durableMetadata?: Record<string, DurableMetadata>;
  textInitializers?: Record<string, { grantId: string; operationId: string; size: number; hash: string; completed?: boolean }>;
  binaryTickets?: BinaryTicket[];
  binaryReferences?: Record<string, BinaryReferenceV2>;
  binaryConflicts?: BinaryConflictV2[];
  binaryRetentionRoots?: BinaryRetentionRoot[];
  presence?: Record<string, PresenceEntry>;
  lastActivityAt?: number;
  rootGeneration?: number;
  binaryGcCandidates?: Record<string, { firstRoundCompletedAt?: number; rootGeneration: number }>;
  binaryGcSweep?: { rootGeneration: number; round: 1 | 2; cursor?: string; attempts: number };
  import?: { operationId: string; expectedManifestHash: string; entries: ImportManifestEntry[]; error?: string; attempts: number };
};

/** An authenticated caller: the host, or the live record of the guest grant whose secret it presented. */
export type Actor = Pick<Grant, "grantId" | "permission" | "authEpoch">;
export const HOST_ACTOR: Actor = { grantId: "host", permission: "host", authEpoch: 1 };
export type Body = Record<string, unknown>;

/** A failure with its own status and error code; anything else thrown maps to 400 invalid_request. */
export class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: object) { super(message); }
}

export function objectValue(value: unknown, message: string): Body { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message); return value as Body; }
export async function readObject(request: Request): Promise<Body> { return objectValue(await request.json(), "JSON object required"); }
export function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`${name} is required`); return value; }
export function requiredInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`); return Number(value); }
const FILE_KINDS: readonly unknown[] = ["text", "binary", "board", "spreadsheet"] satisfies CatalogFileV2["kind"][];
export function requiredFileKind(value: unknown): CatalogFileV2["kind"] { if (!FILE_KINDS.includes(value)) throw new Error("kind must be text, binary, board, or spreadsheet"); return value as CatalogFileV2["kind"]; }
/** Boards and spreadsheets sync through the same Yjs text rooms as text; only binaries live in R2. */
export const isTextSynced = (kind: CatalogFileV2["kind"]): boolean => kind !== "binary";
/** Paths that differ only by case collide. */
export const foldPath = (path: string): string => path.toLocaleLowerCase("en-US");

export function canonicalPath(value: unknown): string {
  const path = requiredString(value, "path").normalize("NFC");
  if (path.length > MAX_PATH || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) throw new Error("Invalid project-relative path");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Path traversal or empty segment");
  return parts.join("/");
}

export function projectName(value: unknown): string {
  const name = requiredString(value, "name").normalize("NFC").trim();
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid project name");
  return name;
}

export function parseImportManifest(value: unknown): ImportManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error("Invalid import manifest");
  const entries = value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid import manifest entry");
    const item = raw as Body;
    if (!FILE_KINDS.includes(item.kind)) throw new Error("Invalid import file kind");
    if (!isSha256(item.hash) || !isBinarySize(item.size)) throw new Error("Invalid import content identity");
    return { fileId: requiredString(item.fileId, "fileId"), path: canonicalPath(item.path), kind: item.kind as CatalogFileV2["kind"], size: Number(item.size), hash: item.hash };
  });
  if (new Set(entries.map((entry) => entry.fileId)).size !== entries.length || new Set(entries.map((entry) => foldPath(entry.path))).size !== entries.length) throw new Error("Import manifest has duplicate identity or case collision");
  return entries;
}

export function strongSecret(value: unknown): string {
  const secret = requiredString(value, "hostSecret");
  if (new TextEncoder().encode(secret).length < 32) throw new Error("Secret must have at least 256 bits of encoded entropy material");
  return secret;
}

/** Guest secrets never reach the server: the host registers their salted hash. */
export function guestSecretHash(value: unknown): SecretHash {
  if (!value || typeof value !== "object") throw new Error("guestSecretHash is required");
  const salt = requiredString((value as Body).salt, "guestSecretHash.salt");
  const hash = requiredString((value as Body).hash, "guestSecretHash.hash");
  if (!/^[A-Za-z0-9_-]{43}$/.test(salt) || !isSha256(hash)) throw new Error("Invalid guest secret hash");
  return { salt, hash };
}

export async function deriveSecretHash(secret: string): Promise<SecretHash> { const salt = randomSecret(); return { salt, hash: await sha256Hex(`${salt}:${secret}`) }; }

/** Constant-time comparison of the salted digest. */
export async function verifySecret(secret: string, stored: SecretHash): Promise<boolean> {
  const actual = await sha256Hex(`${stored.salt}:${secret}`);
  if (actual.length !== stored.hash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ stored.hash.charCodeAt(index);
  return difference === 0;
}

/** The public catalog projection: an explicit field list so no secret or bookkeeping field can leak. */
export function publicCatalog(state: CoordinatorState): CatalogV2 {
  const { protocol, projectInstanceId, name, lifecycle, catalogRevision, snapshotGeneration, workspaceLeaseGeneration, authorityEpoch, files } = state;
  return { protocol, projectInstanceId, ...(name ? { name } : {}), lifecycle, catalogRevision, snapshotGeneration, workspaceLeaseGeneration, authorityEpoch, files };
}

export function requireLive(state: CoordinatorState): void { if (state.lifecycle !== "live") throw new ControlError(409, "project_not_live", "Project is not live"); }
export const isActive = (file: CatalogFileV2): boolean => file.state === "live" || file.state === "initializing";
export function findFile(state: CoordinatorState, fileId: string): CatalogFileV2 { const file = state.files.find((item) => item.fileId === fileId); if (!file) throw new Error("File not found"); return file; }
export function activeFile(state: CoordinatorState, fileId: string): CatalogFileV2 { const file = findFile(state, fileId); if (!isActive(file)) throw new Error("File is not live"); return file; }
export function ensurePathFree(state: CoordinatorState, path: string, except?: string): void {
  if (state.files.some((file) => file.fileId !== except && file.state !== "tombstoned" && foldPath(file.path) === foldPath(path))) throw new Error("Path already exists or case-collides");
}
export const binaryKey = (projectInstanceId: string, fileId: string, hash: string): string => `v2/${projectInstanceId}/${fileId}/${hash}`;
/** Any change to the set of GC roots restarts the sweep, so a stale mark can never delete a newly rooted object. */
export function bumpRoots(state: CoordinatorState): void { state.rootGeneration = (state.rootGeneration ?? 0) + 1; state.binaryGcSweep = undefined; }
export const fenceAck = (file: CatalogFileV2): string => `file-fence:${file.fileId}:${file.documentEpoch}`;
export const closeAck = (fileId: string, documentEpoch: number): string => `file-close:${fileId}:${documentEpoch}`;

export type WorkIdentity = Pick<PendingFileWork, "kind" | "fileId" | "documentEpoch" | "grantId">;
/** Work items are keyed by kind, file and epoch — and, for revocations, the grant. */
export const sameWork = (a: WorkIdentity, b: WorkIdentity): boolean => a.kind === b.kind && a.fileId === b.fileId && a.documentEpoch === b.documentEpoch && (b.kind !== "revoke" || a.grantId === b.grantId);
export function upsertWork(work: PendingFileWork[] | undefined, item: PendingFileWork): PendingFileWork[] {
  const result = work ?? [];
  if (!result.some((entry) => sameWork(entry, item))) result.push(item);
  return result;
}
