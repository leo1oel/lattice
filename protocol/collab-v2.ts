export const CONTROL_PROTOCOL_VERSION = 2 as const;
export const TEXT_FILE_V2_PARTY = "text-file-v2" as const;

export type TextFileRoomIdentityV2 = { protocol: 2; projectInstanceId: string; fileId: string; documentEpoch: number };

export function textFileV2RoomName(projectInstanceId: string, fileId: string, documentEpoch: number): string {
  if (!validRoomId(projectInstanceId) || !validRoomId(fileId) || !Number.isSafeInteger(documentEpoch) || documentEpoch <= 0) throw new Error("Invalid TextFileV2 identity");
  return `v2~${base64UrlText(projectInstanceId)}~${base64UrlText(fileId)}~${documentEpoch}`;
}

export function parseTextFileV2RoomName(room: string): TextFileRoomIdentityV2 | null {
  const match = room.match(/^v2~([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)~([1-9][0-9]*)$/);
  if (!match) return null;
  try {
    const identity: TextFileRoomIdentityV2 = { protocol: 2, projectInstanceId: fromBase64UrlText(match[1]), fileId: fromBase64UrlText(match[2]), documentEpoch: Number(match[3]) };
    return textFileV2RoomName(identity.projectInstanceId, identity.fileId, identity.documentEpoch) === room ? identity : null;
  } catch { return null; }
}

export type ProjectLifecycle = "importing" | "live" | "closing" | "closed";
export type FileLifecycle = "initializing" | "live" | "preparing-delete" | "deleting" | "tombstoned" | "purging";
export type GrantPermission = "read" | "write" | "host";

export type CatalogFileV2 = {
  fileId: string;
  path: string;
  /** Boards sync like text (same Y.Doc rooms); the kind only routes clients to the right editor. */
  kind: "text" | "binary" | "board";
  state: FileLifecycle;
  documentEpoch: number;
  contentRevision?: number;
  size?: number;
  hash?: string;
};

export type CatalogV2 = {
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  projectInstanceId: string;
  lifecycle: ProjectLifecycle;
  catalogRevision: number;
  snapshotGeneration: number;
  workspaceLeaseGeneration: number;
  authorityEpoch: number;
  files: CatalogFileV2[];
};

export type CoordinatorEventV2 = {
  catalogRevision: number;
  type: string;
  fileId?: string;
};

export type OperationResultV2<T = unknown> = {
  operationId: string;
  status: "complete" | "pending";
  catalogRevision: number;
  value?: T;
  pendingAcks?: string[];
};

export type SocketTicketClaimsV2 = {
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  projectInstanceId: string;
  audience: "project" | "file";
  fileId?: string;
  documentEpoch?: number;
  grantId: string;
  permission: GrantPermission;
  grantEpoch: number;
  projectAuthorityEpoch: number;
  expiresAt: number;
};

export type ControlErrorV2 = {
  error: string;
  message: string;
  catalogRevision?: number;
  refetch?: boolean;
};

export const BINARY_OBJECT_VERSION = "lattice-binary-v1" as const;
export const MAX_BINARY_OBJECT_BYTES = 32 * 1024 * 1024;
export type BinaryReferenceV2 = { fileId: string; documentEpoch: number; contentRevision: number; hash: string; size: number; contentType: string };
export type BinaryConflictV2 = { conflictId: string; fileId: string; createdAt: number; winner?: BinaryReferenceV2; loser: BinaryReferenceV2 };
export type BinaryUploadTicketClaimsV2 = {
  protocol: 2; kind: "binary-upload"; projectInstanceId: string; fileId: string; documentEpoch: number;
  grantId: string; permission: "write" | "host"; expectedCatalogRevision: number;
  grantEpoch: number; projectAuthorityEpoch: number;
  expectedContentRevision: number; expectedPriorHash?: string; declaredHash: string; declaredSize: number;
  contentType: string; operationId: string; expiresAt: number;
};
export type BinaryReadTicketClaimsV2 = {
  protocol: 2; kind: "binary-read"; projectInstanceId: string; fileId: string; documentEpoch: number;
  grantId: string; hash: string; size: number; contentType: string; conflictId?: string; expiresAt: number;
  grantEpoch: number; projectAuthorityEpoch: number;
};

export function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function isBoundId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value); }
export function isOperationId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
export function isBinarySize(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_BINARY_OBJECT_BYTES; }
export function isBinaryContentType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value);
}

/** Emitted only after the TextFile snapshot manifest and head are durable. */
export type DurableAckV2 = {
  type: "lattice.durable-ack";
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  projectInstanceId: string;
  fileId: string;
  documentEpoch: number;
  contentRevision: number;
  snapshotGeneration: number;
  stateVector: string;
  size: number;
  hash: string;
};

export function isDurableAckV2(value: unknown): value is DurableAckV2 {
  if (!value || typeof value !== "object") return false;
  const ack = value as Partial<DurableAckV2>;
  return ack.type === "lattice.durable-ack" && ack.protocol === 2
    && typeof ack.projectInstanceId === "string" && ack.projectInstanceId.length > 0
    && typeof ack.fileId === "string" && ack.fileId.length > 0
    && Number.isSafeInteger(ack.documentEpoch) && Number(ack.documentEpoch) > 0
    && isRevision(ack.contentRevision) && isRevision(ack.snapshotGeneration)
    && typeof ack.stateVector === "string" && ack.stateVector.length > 0 && ack.stateVector.length <= 16384
    && /^[A-Za-z0-9_-]+$/.test(ack.stateVector)
    && typeof ack.hash === "string" && /^[a-f0-9]{64}$/.test(ack.hash)
    && isRevision(ack.size);
}

export function isCatalogV2(value: unknown): value is CatalogV2 {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CatalogV2>;
  if (v.protocol !== 2 || typeof v.projectInstanceId !== "string" || !v.projectInstanceId
    || !isRevision(v.catalogRevision) || !isRevision(v.snapshotGeneration)
    || !isRevision(v.workspaceLeaseGeneration) || !isRevision(v.authorityEpoch) || !Array.isArray(v.files)
    || !["importing", "live", "closing", "closed"].includes(v.lifecycle ?? "")) return false;
  return v.files.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const file = entry as Partial<CatalogFileV2>;
    return typeof file.fileId === "string" && file.fileId.length > 0
      && typeof file.path === "string" && file.path.length > 0
      && (file.kind === "text" || file.kind === "binary" || file.kind === "board")
      && ["initializing", "live", "preparing-delete", "deleting", "tombstoned", "purging"].includes(file.state ?? "")
      && Number.isSafeInteger(file.documentEpoch) && Number(file.documentEpoch) > 0
      && (file.contentRevision === undefined || isRevision(file.contentRevision))
      && (file.size === undefined || isRevision(file.size))
      && (file.hash === undefined || typeof file.hash === "string");
  });
}

function isRevision(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validRoomId(value: string): boolean { return /^[A-Za-z0-9_-]{16,128}$/.test(value); }
function base64UrlText(value: string): string { return base64UrlBytes(new TextEncoder().encode(value)); }
function base64UrlBytes(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function fromBase64UrlText(value: string): string { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4)), (c) => c.charCodeAt(0))); }
