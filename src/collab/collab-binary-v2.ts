import { isBinaryContentType, isBinarySize, isOperationId, isSha256, type BinaryConflictV2, type BinaryReferenceV2 } from "../../protocol/collab-v2";

export type BinaryReplaceResult = { status: "complete"; current: BinaryReferenceV2 } | { status: "conflict"; current?: BinaryReferenceV2; conflict: BinaryConflictV2 };
export type WorkspaceLeaseCheck = () => void | Promise<void>;
export class CollabBinaryHttpError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.retryable = status === 408 || status === 429 || status >= 500; }
}
export type CollabBinaryClientOptions = { fetch?: typeof fetch; idFactory?: () => string; checkWorkspaceLease?: WorkspaceLeaseCheck };

export class CollabBinaryV2Client {
  private readonly fetcher: typeof fetch;
  private readonly idFactory: () => string;
  private readonly checkWorkspaceLease?: WorkspaceLeaseCheck;
  private readonly replacements = new Map<string, Promise<BinaryReplaceResult>>();
  constructor(private readonly baseUrl: string, private readonly projectInstanceId: string, private readonly credential: string, options: WorkspaceLeaseCheck | CollabBinaryClientOptions = {}) {
    const normalized = typeof options === "function" ? { checkWorkspaceLease: options } : options;
    this.fetcher = normalized.fetch ?? globalThis.fetch.bind(globalThis);
    this.idFactory = normalized.idFactory ?? (() => crypto.randomUUID());
    this.checkWorkspaceLease = normalized.checkWorkspaceLease;
  }

  async replace(fileId: string, documentEpoch: number, bytes: Uint8Array, contentType: string, expectedCatalogRevision: number, expectedContentRevision: number, expectedPriorHash?: string, operationId = this.idFactory()): Promise<BinaryReplaceResult> {
    const existing = this.replacements.get(operationId);
    if (existing) return existing;
    const pending = this.replaceOnce(fileId, documentEpoch, bytes, contentType, expectedCatalogRevision, expectedContentRevision, expectedPriorHash, operationId);
    this.replacements.set(operationId, pending);
    // Only deduplicate while in flight: the coordinator's idempotency table
    // covers replays after settle, and retaining every success grows the map
    // without bound.
    void pending.then(() => this.replacements.delete(operationId), () => this.replacements.delete(operationId));
    return pending;
  }

  private async replaceOnce(fileId: string, documentEpoch: number, bytes: Uint8Array, contentType: string, expectedCatalogRevision: number, expectedContentRevision: number, expectedPriorHash: string | undefined, operationId: string): Promise<BinaryReplaceResult> {
    await this.checkWorkspaceLease?.();
    if (!isBinarySize(bytes.byteLength) || !isBinaryContentType(contentType) || !isOperationId(operationId)) throw new Error("Invalid binary replacement");
    const hash = await sha256(bytes);
    await this.checkWorkspaceLease?.();
    const ticket = await this.json("binary/upload-tickets", { fileId, documentEpoch, declaredHash: hash, declaredSize: bytes.byteLength, contentType, expectedCatalogRevision, expectedContentRevision, expectedPriorHash, operationId }) as { ticket: string };
    await this.checkWorkspaceLease?.();
    const upload = await this.fetcher(this.url(`binary/uploads/${encodeURIComponent(ticket.ticket)}`), { method: "PUT", headers: { Authorization: `Bearer ${this.credential}`, "content-type": contentType }, body: bytes });
    await this.checkWorkspaceLease?.();
    if (!upload.ok) throw await httpError(upload, "Binary upload failed");
    await this.checkWorkspaceLease?.();
    const committed = await this.json("binary/commit", { ticket: ticket.ticket, operationId }) as BinaryReplaceResult;
    await this.checkWorkspaceLease?.();
    return committed;
  }

  async download(fileId: string, documentEpoch: number, conflictId?: string): Promise<Uint8Array> {
    await this.checkWorkspaceLease?.();
    const issued = await this.json("binary/read-tickets", { fileId, documentEpoch, conflictId }) as { ticket: string; hash: string; size: number };
    await this.checkWorkspaceLease?.();
    if (!isSha256(issued.hash) || !isBinarySize(issued.size)) throw new Error("Invalid binary read authorization");
    const response = await this.fetcher(this.url(`binary/downloads/${encodeURIComponent(issued.ticket)}`), { headers: { Authorization: `Bearer ${this.credential}` } });
    await this.checkWorkspaceLease?.();
    if (!response.ok) throw await httpError(response, "Binary download failed");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== issued.size || await sha256(bytes) !== issued.hash) throw new Error("Downloaded binary failed integrity verification");
    await this.checkWorkspaceLease?.();
    return bytes;
  }

  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, "")}/v2/projects/${encodeURIComponent(this.projectInstanceId)}/${path}`; }
  private async json(path: string, body: object): Promise<unknown> {
    const response = await this.fetcher(this.url(path), { method: "POST", headers: { Authorization: `Bearer ${this.credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    // Parse the body as text first: edge errors (502/520) return HTML, and a
    // bare response.json() would throw SyntaxError, losing the typed
    // CollabBinaryHttpError and its retryable classification.
    const text = await response.text();
    let value: unknown = {};
    try { value = JSON.parse(text); } catch { if (response.ok) throw new Error("Binary control request returned invalid JSON"); }
    if (!response.ok) throw new CollabBinaryHttpError(response.status, (value as { error?: string }).error ?? "request_failed", (value as { message?: string }).message ?? `Binary request failed (${response.status})`);
    return value;
  }
}

async function httpError(response: Response, fallback: string): Promise<CollabBinaryHttpError> {
  let value: { error?: string; message?: string } = {};
  try { value = await response.clone().json() as typeof value; } catch { /* non-JSON upstream */ }
  return new CollabBinaryHttpError(response.status, value.error ?? "request_failed", value.message ?? `${fallback} (${response.status})`);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
