import { routePartykitRequest } from "partyserver";
export { ProjectCoordinatorV2 } from "./project-coordinator-v2";
import type { ProjectCoordinatorV2 } from "./project-coordinator-v2";
export { TextFileV2 } from "./text-file-v2";
import { parseTextFileV2RoomName, type TextFileV2 } from "./text-file-v2";
import { BINARY_OBJECT_VERSION, MAX_BINARY_OBJECT_BYTES, textFileV2RoomName } from "../../protocol/collab-v2";
import { binaryKey } from "./project-coordinator-v2";

type Env = {
  ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2>;
  TextFileV2: DurableObjectNamespace<TextFileV2>;
  BinaryObjects: R2Bucket;
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v2\/projects\/([^/]+)(?:\/|$)/);
    if (match) {
      const projectInstanceId = decodeURIComponent(match[1]);
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(projectInstanceId)) return new Response("Invalid projectInstanceId", { status: 400 });
      const binary = url.pathname.match(/^\/v2\/projects\/[^/]+\/binary\/(uploads|downloads)\/([^/]+)$/);
      if (binary) return binary[1] === "uploads" ? uploadBinary(request, env, projectInstanceId, decodeURIComponent(binary[2])) : downloadBinary(request, env, projectInstanceId, decodeURIComponent(binary[2]));
      const textImport = url.pathname.match(/^\/v2\/projects\/[^/]+\/text\/imports\/([^/]+)$/);
      if (textImport) return importText(request, env, projectInstanceId, decodeURIComponent(textImport[1]));
      return env.ProjectCoordinatorV2.getByName(projectInstanceId).fetch(request);
    }
    return (
      (await routePartykitRequest(request, env as never, {
        onBeforeConnect: async (incoming, lobby) => {
          if (lobby.className !== "TextFileV2") return;
          const identity = parseTextFileV2RoomName(lobby.name);
          if (!identity) return typedV2Error(400, "invalid_room");
          const sanitized = new URL(incoming.url);
          const ticket = sanitized.searchParams.get("ticket") ?? "";
          sanitized.searchParams.delete("ticket");
          if (!ticket) return typedV2Error(401, "ticket_required");
          const claims = await env.ProjectCoordinatorV2.getByName(identity.projectInstanceId).consumeSocketTicket(ticket, "file", identity.fileId, identity.documentEpoch);
          if (!claims || claims.projectInstanceId !== identity.projectInstanceId || claims.fileId !== identity.fileId || claims.documentEpoch !== identity.documentEpoch) return typedV2Error(403, "invalid_ticket");
          const headers = new Headers(incoming.headers);
          headers.set("x-lattice-project", claims.projectInstanceId);
          headers.set("x-lattice-file", claims.fileId!);
          headers.set("x-lattice-epoch", String(claims.documentEpoch));
          headers.set("x-lattice-grant", claims.grantId);
          headers.set("x-lattice-permission", claims.permission);
          headers.set("x-lattice-grant-epoch", String(claims.grantEpoch));
          headers.set("x-lattice-authority-epoch", String(claims.projectAuthorityEpoch));
          return new Request(sanitized, { method: incoming.method, headers });
        },
      }))
      ?? new Response("Lattice collab server", { status: 200 })
    );
  },
} satisfies ExportedHandler<Env>;

async function importText(request: Request, env: Env, projectId: string, fileId: string): Promise<Response> {
  if (request.method !== "PUT") return typedV2Error(405, "method");
  const size = Number(request.headers.get("content-length"));
  const epoch = Number(request.headers.get("x-document-epoch"));
  const hash = request.headers.get("x-content-sha256") ?? "";
  const operationId = request.headers.get("x-operation-id") ?? "";
  const credential = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 * 1024) return typedV2Error(size > 5 * 1024 * 1024 ? 413 : 400, "invalid_size");
  const coordinator = env.ProjectCoordinatorV2.getByName(projectId);
  if (!await coordinator.authorizeTextImport(credential, fileId, epoch, operationId, size, hash)) return typedV2Error(403, "import_not_authorized");
  const bytes = await readBounded(request.body, 5 * 1024 * 1024);
  if (!bytes || bytes.byteLength !== size) return typedV2Error(bytes ? 400 : 413, "size_mismatch");
  if (await hashBytes(bytes) !== hash) return typedV2Error(400, "hash_mismatch");
  try {
    const result = await env.TextFileV2.getByName(textFileV2RoomName(projectId, fileId, epoch)).initializeImport(projectId, fileId, epoch, operationId, bytes, hash);
    if (!await coordinator.completeTextImport(fileId, epoch, size, hash)) return typedV2Error(409, "coordinator_import_state");
    return jsonResponse({ status: result }, result === "created" ? 201 : 200);
  } catch (error) {
    const code = error instanceof Error ? error.message : "import_failed";
    return typedV2Error(code === "invalid_utf8" ? 400 : 409, code);
  }
}

function typedV2Error(status: number, error: string): Response {
  return new Response(JSON.stringify({ protocol: 2, error }), { status, headers: { "content-type": "application/json" } });
}

async function uploadBinary(request: Request, env: Env, projectId: string, ticket: string): Promise<Response> {
  if (request.method !== "PUT") return typedV2Error(405, "method");
  const rawLength = request.headers.get("content-length");
  if (rawLength === null || !/^(0|[1-9][0-9]*)$/.test(rawLength)) return typedV2Error(411, "content_length_required");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BINARY_OBJECT_BYTES) return typedV2Error(length > MAX_BINARY_OBJECT_BYTES ? 413 : 400, "invalid_size");
  const coordinator = env.ProjectCoordinatorV2.getByName(projectId);
  const claims = await coordinator.consumeBinaryUploadTicket(ticket);
  if (!claims || claims.declaredSize !== length || request.headers.get("content-type") !== claims.contentType) return typedV2Error(403, "invalid_ticket");
  const bytes = await readBounded(request.body, MAX_BINARY_OBJECT_BYTES);
  if (!bytes || bytes.byteLength !== claims.declaredSize) return typedV2Error(bytes ? 400 : 413, "size_mismatch");
  const hash = await hashBytes(bytes);
  if (hash !== claims.declaredHash) return typedV2Error(400, "hash_mismatch");
  const key = binaryKey(projectId, claims.fileId, hash);
  const metadata = { sha256: hash, size: String(bytes.byteLength), version: BINARY_OBJECT_VERSION, projectInstanceId: projectId, fileId: claims.fileId, contentType: claims.contentType };
  const existing = await env.BinaryObjects.head(key);
  if (existing) {
    if (!binaryMetadataMatches(existing, metadata, bytes.byteLength, claims.contentType) || !await storedBinaryMatches(env.BinaryObjects, key, hash, bytes.byteLength)) return typedV2Error(409, "immutable_key_collision");
  } else {
    try {
      await env.BinaryObjects.put(key, bytes, { httpMetadata: { contentType: claims.contentType }, customMetadata: metadata });
      const verified = await env.BinaryObjects.head(key);
      if (!verified || !binaryMetadataMatches(verified, metadata, bytes.byteLength, claims.contentType) || !await storedBinaryMatches(env.BinaryObjects, key, hash, bytes.byteLength)) return typedV2Error(502, "object_write_unverified");
    } catch {
      return typedV2Error(503, "object_store_unavailable");
    }
  }
  if (!await coordinator.markBinaryUploaded(ticket, claims, key)) return typedV2Error(409, "upload_state");
  return new Response(null, { status: existing ? 200 : 201, headers: { ETag: `"${hash}"` } });
}

async function downloadBinary(request: Request, env: Env, projectId: string, ticket: string): Promise<Response> {
  if (request.method !== "GET") return typedV2Error(405, "method");
  const claims = await env.ProjectCoordinatorV2.getByName(projectId).consumeBinaryReadTicket(ticket);
  if (!claims) return typedV2Error(403, "invalid_ticket");
  const object = await env.BinaryObjects.get(binaryKey(projectId, claims.fileId, claims.hash));
  const expectedMetadata = { sha256: claims.hash, size: String(claims.size), version: BINARY_OBJECT_VERSION, projectInstanceId: projectId, fileId: claims.fileId, contentType: claims.contentType };
  if (!object || !binaryMetadataMatches(object, expectedMetadata, claims.size, claims.contentType)) {
    console.error(JSON.stringify({ event: "binary_integrity_failure", projectInstanceId: projectId, fileId: claims.fileId }));
    return typedV2Error(502, "binary_integrity_failure");
  }
  const bytes = await readBounded(object.body, MAX_BINARY_OBJECT_BYTES);
  if (!bytes || await hashBytes(bytes) !== claims.hash) return typedV2Error(502, "binary_integrity_failure");
  return new Response(bytes, { headers: { "content-type": claims.contentType, "content-length": String(claims.size), ETag: `"${claims.hash}"`, "cache-control": "private, max-age=0, must-revalidate", "x-content-type-options": "nosniff" } });
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > limit) { await reader.cancel(); return null; } chunks.push(item.value); }
  const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; } return out;
}
async function hashBytes(bytes: Uint8Array): Promise<string> { const value = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

function binaryMetadataMatches(object: Pick<R2Object, "size" | "customMetadata" | "httpMetadata">, expected: Record<string, string>, size: number, contentType: string): boolean {
  return object.size === size && object.httpMetadata?.contentType === contentType
    && Object.entries(expected).every(([key, value]) => object.customMetadata?.[key] === value);
}

async function storedBinaryMatches(bucket: R2Bucket, key: string, hash: string, size: number): Promise<boolean> {
  try {
    const object = await bucket.get(key);
    if (!object || object.size !== size) return false;
    const bytes = await readBounded(object.body, MAX_BINARY_OBJECT_BYTES);
    return bytes !== null && bytes.byteLength === size && await hashBytes(bytes) === hash;
  } catch { return false; }
}
