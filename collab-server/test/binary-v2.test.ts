import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/encoding";
import { createProject, putBinary, uploadTicket } from "./harness";

const figureProject = (label: string) => createProject(label, { kind: "binary", paths: ["figure.pdf"], ready: true });

describe("binary v2 real Worker, DO, and R2", () => {
  it("uploads, commits, downloads verified bytes, and enforces one-use tickets", async () => {
    const { id, fileId, call } = await figureProject("binary");
    const bytes = new TextEncoder().encode("pdf");
    const operationId = "operation-happy";
    const { ticket } = await uploadTicket(id, fileId, bytes, { operationId });
    expect((await putBinary(id, ticket, bytes)).status).toBe(201);
    expect((await putBinary(id, ticket, bytes)).status).toBe(403);
    expect((await call("binary/commit", { body: { ticket, operationId } })).body.status).toBe("complete");
    const read = (await call("binary/read-tickets", { body: { fileId, documentEpoch: 1 } })).body;
    const downloaded = await SELF.fetch(`https://worker/v2/projects/${id}/binary/downloads/${read.ticket}`);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    ["hash", { declaredHash: "0".repeat(64) }, "application/pdf", 5, 400],
    ["size", { declaredSize: 6 }, "application/pdf", 6, 400],
    ["content type", {}, "image/png", 5, 403],
    ["missing length", {}, "application/pdf", undefined, 411],
    ["oversized length", {}, "application/pdf", 32 * 1024 * 1024 + 1, 413],
  ] as const)("rejects an upload with a bad %s", async (_case, claims, contentType, length, status) => {
    const { id, fileId } = await figureProject("binary-reject");
    const bytes = new TextEncoder().encode("bytes");
    const { ticket } = await uploadTicket(id, fileId, bytes, claims);
    const headers = new Headers({ "content-type": contentType });
    if (length !== undefined) headers.set("content-length", String(length));
    // Only a streamed body can be sent without a content-length.
    const body = length === undefined ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : bytes;
    expect((await putBinary(id, ticket, body, headers)).status).toBe(status);
  });

  it("keeps two raced objects, preserves the winner, and replays one conflict", async () => {
    const { id, fileId, call } = await figureProject("binary-race");
    const commit = async (bytes: Uint8Array, operationId: string) => {
      const { ticket } = await uploadTicket(id, fileId, bytes, { operationId });
      await putBinary(id, ticket, bytes);
      return { ticket, result: (await call("binary/commit", { body: { ticket, operationId } })).body };
    };
    const winner = new TextEncoder().encode("winner");
    const loser = new TextEncoder().encode("loser");
    expect((await commit(winner, "operation-winner")).result.status).toBe("complete");
    const raced = await commit(loser, "operation-loser");
    expect(raced.result.status).toBe("conflict");
    const replay = (await call("binary/commit", { body: { ticket: raced.ticket, operationId: "operation-loser" } })).body;
    expect(replay.conflict.conflictId).toBe(raced.result.conflict.conflictId);
    for (const bytes of [winner, loser]) expect(await env.BinaryObjects.head(`v2/${id}/${fileId}/${await sha256Hex(bytes)}`)).not.toBeNull();
  });
});
