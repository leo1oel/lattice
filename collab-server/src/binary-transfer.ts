import { BINARY_OBJECT_VERSION, MAX_BINARY_OBJECT_BYTES, textFileV2RoomName } from "../../protocol/collab-v2";
import { sha256Hex } from "../../protocol/encoding";
import { binaryKey, MAX_TEXT_BYTES } from "./coordinator-model";
import type { Env } from "./index";
import { json, logEvent, readBounded, typedError } from "./runtime";

// The Worker's byte-moving routes. The coordinator authorizes every transfer
// (a one-use ticket or an initializer) before any byte is accepted or served.

/** Initial content of a text-synced file, declared by its create initializer or the import manifest. */
export async function importText(request: Request, env: Env, projectId: string, fileId: string): Promise<Response> {
  if (request.method !== "PUT") return typedError(405, "method");
  const size = Number(request.headers.get("content-length"));
  const epoch = Number(request.headers.get("x-document-epoch"));
  const hash = request.headers.get("x-content-sha256") ?? "";
  const operationId = request.headers.get("x-operation-id") ?? "";
  const credential = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TEXT_BYTES) return typedError(size > MAX_TEXT_BYTES ? 413 : 400, "invalid_size");
  const coordinator = env.ProjectCoordinatorV2.getByName(projectId);
  if (!await coordinator.authorizeTextImport(credential, fileId, epoch, operationId, size, hash)) return typedError(403, "import_not_authorized");
  const bytes = await readBounded(request.body, MAX_TEXT_BYTES);
  if (!bytes || bytes.byteLength !== size) return typedError(bytes ? 400 : 413, "size_mismatch");
  if (await sha256Hex(bytes) !== hash) return typedError(400, "hash_mismatch");
  try {
    const result = await env.TextFileV2.getByName(textFileV2RoomName(projectId, fileId, epoch)).initializeImport(projectId, fileId, epoch, operationId, bytes, hash);
    if (!await coordinator.completeTextImport(fileId, epoch, size, hash)) return typedError(409, "coordinator_import_state");
    return json({ status: result }, result === "created" ? 201 : 200);
  } catch (error) {
    const code = error instanceof Error ? error.message : "import_failed";
    return typedError(code === "invalid_utf8" ? 400 : 409, code);
  }
}

export async function uploadBinary(request: Request, env: Env, projectId: string, ticket: string): Promise<Response> {
  if (request.method !== "PUT") return typedError(405, "method");
  const rawLength = request.headers.get("content-length");
  if (rawLength === null || !/^(0|[1-9][0-9]*)$/.test(rawLength)) return typedError(411, "content_length_required");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BINARY_OBJECT_BYTES) return typedError(length > MAX_BINARY_OBJECT_BYTES ? 413 : 400, "invalid_size");
  const coordinator = env.ProjectCoordinatorV2.getByName(projectId);
  const claims = await coordinator.consumeBinaryUploadTicket(ticket);
  if (!claims || claims.declaredSize !== length || request.headers.get("content-type") !== claims.contentType) return typedError(403, "invalid_ticket");
  const bytes = await readBounded(request.body, MAX_BINARY_OBJECT_BYTES);
  if (!bytes || bytes.byteLength !== claims.declaredSize) return typedError(bytes ? 400 : 413, "size_mismatch");
  const hash = await sha256Hex(bytes);
  if (hash !== claims.declaredHash) return typedError(400, "hash_mismatch");
  const key = binaryKey(projectId, claims.fileId, hash);
  const metadata = binaryMetadata(projectId, claims.fileId, hash, bytes.byteLength, claims.contentType);
  // Keys are content-addressed and immutable: an existing object is reused only if it verifiably holds these bytes.
  const existing = await env.BinaryObjects.head(key);
  if (existing) {
    if (!await storedObjectMatches(env.BinaryObjects, key, existing, metadata)) return typedError(409, "immutable_key_collision");
  } else {
    try {
      await env.BinaryObjects.put(key, bytes, { httpMetadata: { contentType: claims.contentType }, customMetadata: metadata });
      const verified = await env.BinaryObjects.head(key);
      if (!verified || !await storedObjectMatches(env.BinaryObjects, key, verified, metadata)) return typedError(502, "object_write_unverified");
    } catch {
      return typedError(503, "object_store_unavailable");
    }
  }
  if (!await coordinator.markBinaryUploaded(ticket, claims, key)) return typedError(409, "upload_state");
  return new Response(null, { status: existing ? 200 : 201, headers: { ETag: `"${hash}"` } });
}

export async function downloadBinary(request: Request, env: Env, projectId: string, ticket: string): Promise<Response> {
  if (request.method !== "GET") return typedError(405, "method");
  const claims = await env.ProjectCoordinatorV2.getByName(projectId).consumeBinaryReadTicket(ticket);
  if (!claims) return typedError(403, "invalid_ticket");
  const object = await env.BinaryObjects.get(binaryKey(projectId, claims.fileId, claims.hash));
  if (!object || !metadataMatches(object, binaryMetadata(projectId, claims.fileId, claims.hash, claims.size, claims.contentType))) {
    logEvent("binary_integrity_failure", { projectInstanceId: projectId, fileId: claims.fileId }, "error");
    return typedError(502, "binary_integrity_failure");
  }
  const bytes = await readBounded(object.body, MAX_BINARY_OBJECT_BYTES);
  if (!bytes || await sha256Hex(bytes) !== claims.hash) return typedError(502, "binary_integrity_failure");
  return new Response(bytes, { headers: { "content-type": claims.contentType, "content-length": String(claims.size), ETag: `"${claims.hash}"`, "cache-control": "private, max-age=0, must-revalidate", "x-content-type-options": "nosniff" } });
}

function binaryMetadata(projectInstanceId: string, fileId: string, sha256: string, size: number, contentType: string): Record<string, string> {
  return { sha256, size: String(size), version: BINARY_OBJECT_VERSION, projectInstanceId, fileId, contentType };
}

function metadataMatches(object: Pick<R2Object, "size" | "customMetadata" | "httpMetadata">, expected: Record<string, string>): boolean {
  return object.size === Number(expected.size) && object.httpMetadata?.contentType === expected.contentType
    && Object.entries(expected).every(([key, value]) => object.customMetadata?.[key] === value);
}

async function storedObjectMatches(bucket: R2Bucket, key: string, head: R2Object, expected: Record<string, string>): Promise<boolean> {
  if (!metadataMatches(head, expected)) return false;
  try {
    const object = await bucket.get(key);
    if (!object || object.size !== Number(expected.size)) return false;
    const bytes = await readBounded(object.body, MAX_BINARY_OBJECT_BYTES);
    return bytes !== null && bytes.byteLength === Number(expected.size) && await sha256Hex(bytes) === expected.sha256;
  } catch { return false; }
}
