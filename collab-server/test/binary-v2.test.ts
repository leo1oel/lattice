import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";

declare module "cloudflare:workers" { namespace Cloudflare { interface Env { ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2>; BinaryObjects: R2Bucket } } }
const secret = "host-secret-with-at-least-thirty-two-bytes";
let n = 0;
async function post(id: string, path: string, body: object, credential = secret) {
  return SELF.fetch(`https://worker/v2/projects/${id}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function project() {
  const id = `binary-${++n}-abcdefghijklmnop`;
  await post(id, "bootstrap", { projectInstanceId: id, hostSecret: secret, paths: ["figure.pdf"], kind: "binary" }, "");
  await post(id, "import-finalize", { operationId: crypto.randomUUID(), expectedCatalogRevision: 0 });
  const catalog = await (await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).json<any>();
  await env.ProjectCoordinatorV2.getByName(id).acknowledgeFileReady(catalog.files[0].fileId, 1);
  return { id, fileId: catalog.files[0].fileId };
}
async function sha(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join(""); }
async function ticket(id: string, fileId: string, bytes: Uint8Array, operationId = crypto.randomUUID(), overrides: object = {}) {
  const response = await post(id, "binary/upload-tickets", { fileId, documentEpoch: 1, declaredHash: await sha(bytes), declaredSize: bytes.length, contentType: "application/pdf", expectedCatalogRevision: 2, expectedContentRevision: 0, operationId, ...overrides });
  return response.json<any>();
}

describe("binary v2 real Worker, DO, and R2", () => {
  it("uploads, commits, downloads verified bytes, and enforces one-use tickets", async () => {
    const { id, fileId } = await project(); const bytes = new TextEncoder().encode("pdf"); const operationId = "operation-happy";
    const issued = await ticket(id, fileId, bytes, operationId);
    const upload = await SELF.fetch(`https://worker/v2/projects/${id}/binary/uploads/${issued.ticket}`, { method: "PUT", headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes });
    expect(upload.status).toBe(201);
    expect((await SELF.fetch(`https://worker/v2/projects/${id}/binary/uploads/${issued.ticket}`, { method: "PUT", headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes })).status).toBe(403);
    const committed = await (await post(id, "binary/commit", { ticket: issued.ticket, operationId })).json<any>();
    expect(committed.status).toBe("complete");
    const read = await (await post(id, "binary/read-tickets", { fileId, documentEpoch: 1 })).json<any>();
    const downloaded = await SELF.fetch(`https://worker/v2/projects/${id}/binary/downloads/${read.ticket}`);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects hash, size, content type, missing length, and oversized length", async () => {
    const { id, fileId } = await project(); const bytes = new TextEncoder().encode("bytes");
    for (const [override, body, type, length, status] of [
      [{ declaredHash: "0".repeat(64) }, bytes, "application/pdf", String(bytes.length), 400],
      [{ declaredSize: bytes.length + 1 }, bytes, "application/pdf", String(bytes.length + 1), 400],
      [{}, bytes, "image/png", String(bytes.length), 403],
      [{}, bytes, "application/pdf", undefined, 411],
      [{}, bytes, "application/pdf", String(32 * 1024 * 1024 + 1), 413],
    ] as const) {
      const issued = await ticket(id, fileId, bytes, crypto.randomUUID(), override);
      const headers = new Headers({ "content-type": type }); if (length) headers.set("content-length", length);
      const requestBody = length === undefined ? new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }) : body;
      const response = await SELF.fetch(`https://worker/v2/projects/${id}/binary/uploads/${issued.ticket}`, { method: "PUT", headers, body: requestBody });
      expect(response.status).toBe(status);
    }
  });

  it("keeps two raced objects, preserves the winner, and replays one conflict", async () => {
    const { id, fileId } = await project(); const a = new TextEncoder().encode("winner"); const b = new TextEncoder().encode("loser");
    const commit = async (bytes: Uint8Array, operationId: string) => { const issued = await ticket(id, fileId, bytes, operationId); await SELF.fetch(`https://worker/v2/projects/${id}/binary/uploads/${issued.ticket}`, { method: "PUT", headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes }); return { issued, response: await post(id, "binary/commit", { ticket: issued.ticket, operationId }) }; };
    expect((await (await commit(a, "operation-winner")).response.json<any>()).status).toBe("complete");
    const raced = await commit(b, "operation-loser"); const first = await raced.response.json<any>(); expect(first.status).toBe("conflict");
    const replay = await (await post(id, "binary/commit", { ticket: raced.issued.ticket, operationId: "operation-loser" })).json<any>();
    expect(replay.conflict.conflictId).toBe(first.conflict.conflictId);
    expect(await env.BinaryObjects.head(`v2/${id}/${fileId}/${await sha(a)}`)).not.toBeNull();
    expect(await env.BinaryObjects.head(`v2/${id}/${fileId}/${await sha(b)}`)).not.toBeNull();
  });
});
