import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject, EMPTY_SHA256, guestSecretHash, HOST_SECRET, projectId, request, storedState } from "./harness";

const guestSecret = "guest-secret-with-at-least-thirty-two-bytes";
const readSecret = `${guestSecret}-read`;

describe("ProjectCoordinatorV2", () => {
  it("bootstraps once, validates routing and secrets, persists across restart, and requires auth", async () => {
    const unbooted = projectId("bad");
    const unbootedStub = env.ProjectCoordinatorV2.getByName(unbooted);
    expect((await request(unbootedStub, unbooted, "bootstrap", { credential: null, body: { projectInstanceId: "different-abcdefghijkl", hostSecret: HOST_SECRET } })).status).toBe(400);
    expect((await request(unbootedStub, unbooted, "bootstrap", { credential: null, body: { projectInstanceId: unbooted, hostSecret: "weak" } })).status).toBe(400);
    const { id, stub, call } = await createProject("persist", { direct: true, paths: ["paper.md"], finalize: false });
    expect((await call("catalog", { credential: null })).status).toBe(401);
    expect((await call("create", { credential: null, body: {} })).status).toBe(401);
    await evictDurableObject(stub);
    expect((await call("catalog")).body.files[0].path).toBe("paper.md");
    expect((await call("bootstrap", { credential: null, body: { projectInstanceId: id, hostSecret: HOST_SECRET } })).status).toBe(409);
  });

  it("persists a room name and only lets the host rename it", async () => {
    const { call, mutate } = await createProject("room-name", { direct: true, name: "Draft room" });
    expect((await mutate("grants", 1, { permission: "write", guestSecretHash: await guestSecretHash(guestSecret) })).status).toBe(200);
    expect((await mutate("project-rename", 2, { name: "Guest name" }, guestSecret)).status).toBe(403);
    expect((await mutate("project-rename", 2, { name: "Final room" })).status).toBe(200);
    expect((await call("catalog")).body.name).toBe("Final room");
  });

  it("enforces permissions and revocation immediately without retaining plaintext secrets", async () => {
    const { stub, call, mutate } = await createProject("permissions", { direct: true });
    const grant = await mutate("grants", 1, { permission: "write", guestSecretHash: await guestSecretHash(guestSecret) });
    expect(JSON.stringify(grant.body)).not.toContain(guestSecret);
    const grantId = grant.body.value.grantId;
    const listed = await call("grants");
    expect(listed.body).toEqual([{ grantId, permission: "write", revoked: false, authEpoch: 1 }]);
    expect(JSON.stringify(listed.body)).not.toContain("hash");
    expect((await call("grants", { credential: guestSecret })).status).toBe(403);
    expect((await mutate("close-begin", 2, {}, guestSecret)).status).toBe(403);
    expect((await mutate("create", 2, { path: "guest.md", kind: "text" }, guestSecret)).status).toBe(200);
    await mutate("grants", 3, { permission: "read", guestSecretHash: await guestSecretHash(readSecret) });
    expect((await mutate("create", 4, { path: "read.md", kind: "text" }, readSecret)).status).toBe(403);
    await mutate("revoke", 4, { grantId });
    expect((await call("catalog", { credential: guestSecret })).status).toBe(401);
    expect(JSON.stringify(await storedState(stub))).not.toContain(guestSecret);
  });

  it("lets a write guest durably create the comments file while the host is offline", async () => {
    const { stub, call, mutate } = await createProject("durable-create", { direct: true });
    const writeGrant = await mutate("grants", 1, { permission: "write", guestSecretHash: await guestSecretHash(guestSecret) });
    await mutate("grants", 2, { permission: "read", guestSecretHash: await guestSecretHash(readSecret) });
    const otherWriterSecret = `${guestSecret}-other-writer`;
    await mutate("grants", 3, { permission: "write", guestSecretHash: await guestSecretHash(otherWriterSecret) });
    const hash = "a".repeat(64);
    const operationId = "initialize_guest_text";
    const created = await mutate("create", 4, { path: ".research/editor-comments.json", kind: "text", initializer: { operationId, size: 12, hash } }, guestSecret);
    const fileId = created.body.value.fileId as string;
    const authorize = (secret: string) => stub.authorizeTextImport(secret, fileId, 1, operationId, 12, hash);

    expect(created.body.value.state).toBe("initializing");
    expect(await authorize(guestSecret)).toBe(true);
    expect(await authorize(otherWriterSecret)).toBe(false);
    expect(await authorize(readSecret)).toBe(false);
    expect((await mutate("file-ready", 5, { fileId })).status).toBe(400);
    expect(await stub.completeTextImport(fileId, 1, 12, hash)).toBe(false);
    expect((await call("catalog", { credential: guestSecret })).body.files[0].state).toBe("initializing");

    expect(await stub.updateTextDurableMetadata(fileId, 1, 1, 1, 20, "b".repeat(64), "state-vector")).toBe(true);
    expect(await stub.completeTextImport(fileId, 1, 12, hash)).toBe(true);
    const catalog = await call("catalog", { credential: guestSecret });
    expect(catalog.body.files[0]).toMatchObject({ fileId, path: ".research/editor-comments.json", state: "live", size: 12, hash });

    // A lost 201 can retry the same TextFile operation after publication.
    expect(await authorize(guestSecret)).toBe(true);
    expect(await stub.completeTextImport(fileId, 1, 12, hash)).toBe(true);
    await mutate("revoke", catalog.body.catalogRevision, { grantId: writeGrant.body.value.grantId });
    expect(await authorize(guestSecret)).toBe(false);
  });

  it("provides CAS and recursively canonical idempotency", async () => {
    const { call, mutate } = await createProject("cas", { direct: true });
    const operationId = crypto.randomUUID();
    const initializer = { operationId: "initialize_cas", size: 0, hash: EMPTY_SHA256 };
    const firstBody = { operationId, expectedCatalogRevision: 1, path: "a.md", kind: "text", initializer, metadata: { z: 1, a: 2 } };
    const first = await call("create", { body: firstBody });
    const retry = await call("create", { body: { metadata: { a: 2, z: 1 }, initializer, path: "a.md", kind: "text", expectedCatalogRevision: 1, operationId } });
    expect(retry.body).toEqual(first.body);
    expect((await call("create", { body: { ...firstBody, path: "b.md" } })).body.error).toBe("operation_id_reuse");
    expect((await mutate("create", 1, { path: "stale.md" })).body.error).toBe("catalog_revision_conflict");
  });

  it("preserves identity through rename and safely fences deletion and recreation", async () => {
    const { stub, fileId, mutate } = await createProject("delete", { direct: true, paths: ["old.md"] });
    expect(await stub.acknowledgeFileReady(fileId, 99)).toBe(false);
    expect(await stub.acknowledgeFileReady(fileId, 1)).toBe(true);
    expect((await mutate("rename", 2, { fileId, path: "new.md" })).body.value.fileId).toBe(fileId);
    expect((await mutate("delete-begin", 3, { fileId })).body.status).toBe("complete");
    expect(await stub.acknowledgeFileDeleted(fileId, 2)).toBe(false);
    expect(await stub.acknowledgeFileDeleted(fileId, 1)).toBe(true);
    expect(await stub.acknowledgeFileReady(fileId, 1)).toBe(false);
    expect((await mutate("create", 4, { path: "new.md", kind: "text" })).body.value.fileId).not.toBe(fileId);
  });

  it("closes only after every file fence ACK and denies tickets immediately", async () => {
    const { stub, files, call, mutate } = await createProject("close", { direct: true, paths: ["a.md", "b.md"], ready: true });
    expect((await mutate("close-begin", 3)).body.status).toBe("complete");
    expect((await call("tickets", { body: { audience: "project" } })).status).toBe(409);
    expect(await stub.acknowledgeFileClosed(files[0].fileId, 2)).toBe(false);
    expect(await stub.acknowledgeFileClosed(files[0].fileId, 1)).toBe(true);
    expect(await stub.acknowledgeFileClosed(files[1].fileId, 1)).toBe(true);
    expect((await call("catalog")).body.lifecycle).toBe("closed");
  });

  it("issues bound one-use tickets and invalidates them on closing", async () => {
    const { id, stub, fileId, call, mutate } = await createProject("tickets", { direct: true, paths: ["a.md"], ready: true });
    const { ticket } = (await call("tickets", { body: { audience: "file", fileId } })).body;
    expect(await stub.consumeSocketTicket(ticket, "file", "wrong")).toBeNull();
    expect(await stub.consumeSocketTicket(ticket, "file", fileId, 2)).toBeNull();
    expect(await stub.consumeSocketTicket(ticket, "file", fileId)).toMatchObject({ projectInstanceId: id, audience: "file", fileId, documentEpoch: 1, grantId: "host", permission: "host" });
    expect(await stub.consumeSocketTicket(ticket, "file", fileId)).toBeNull();
    const pending = (await call("tickets", { body: { audience: "project" } })).body.ticket;
    await mutate("close-begin", 2);
    expect(await stub.consumeSocketTicket(pending, "project")).toBeNull();
  });

  it("invalidates an unconsumed guest ticket immediately after revocation", async () => {
    const { id, stub, fileId, call, mutate } = await createProject("revoked-ticket", { direct: true, paths: ["a.md"], ready: true });
    const grantId = (await mutate("grants", 2, { permission: "write", guestSecretHash: await guestSecretHash(guestSecret) })).body.value.grantId;
    const { ticket, claims } = (await call("tickets", { credential: guestSecret, body: { audience: "file", fileId } })).body;
    const authority = claims.projectAuthorityEpoch;
    expect(await stub.authorizeTextMessage(id, fileId, 1, grantId, 1, authority)).toBe(true);
    await mutate("revoke", 3, { grantId });
    expect(await stub.consumeSocketTicket(ticket, "file", fileId, 1)).toBeNull();
    expect(await stub.authorizeTextMessage(id, fileId, 1, grantId, 1, authority)).toBe(false);
    expect(await stub.authorizeTextMessage(id, fileId, 1, "host", 1, authority)).toBe(false);
    expect(await stub.authorizeTextMessage(id, fileId, 1, "host", 1, authority + 1)).toBe(true);
  });

  it("retains failed fence work with retry metadata and clears it on an idempotent callback", async () => {
    const { stub, fileId, mutate } = await createProject("fence-retry", { direct: true, paths: ["a.md"], ready: true });
    await mutate("delete-begin", 2, { fileId });
    const replacePendingWork = (pendingFileWork: object[], runAlarm = false) => runInDurableObject(stub, async (instance, state) => {
      const stored = { ...await state.storage.get<any>("coordinator:v2"), pendingFileWork };
      await state.storage.put("coordinator:v2", stored);
      (instance as any).state = stored;
      if (runAlarm) await instance.alarm();
    });
    await replacePendingWork([{ kind: "delete", fileId: "permanently-invalid-file", documentEpoch: 99 }], true);
    const [pending] = (await storedState(stub)).pendingFileWork;
    expect(pending).toMatchObject({ kind: "delete", fileId: "permanently-invalid-file", lastAttemptAt: expect.any(Number) });
    expect(pending.attempts).toBeGreaterThanOrEqual(1);
    await replacePendingWork([{ kind: "delete", fileId, documentEpoch: 1 }]);
    expect(await stub.acknowledgeFileDeleted(fileId, 1)).toBe(true);
    expect(await stub.acknowledgeFileDeleted(fileId, 1)).toBe(true);
    expect((await storedState(stub)).pendingFileWork).toEqual([]);
  });

  it("orders events and rejects path traversal, case collisions, and retention gaps", async () => {
    const { stub, call, mutate } = await createProject("events", { direct: true });
    await mutate("create", 1, { path: "Paper.md", kind: "text" });
    expect((await mutate("create", 2, { path: "paper.md", kind: "text" })).status).toBe(400);
    expect((await mutate("create", 2, { path: "../escape.md", kind: "text" })).status).toBe(400);
    expect((await call("events?since=0")).body.events.map((event: any) => event.catalogRevision)).toEqual([1, 2]);
    await runInDurableObject(stub, async (_instance, state) => {
      const value = await state.storage.get<any>("coordinator:v2");
      value.events = [{ catalogRevision: value.catalogRevision, type: "retained" }];
      await state.storage.put("coordinator:v2", value);
    });
    await evictDurableObject(stub);
    expect((await call("events?since=0")).body.refetch).toBe(true);
  });
});
