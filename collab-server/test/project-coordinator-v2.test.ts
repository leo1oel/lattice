import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";

declare module "cloudflare:workers" {
  namespace Cloudflare { interface Env { ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2> } }
}

const hostSecret = "host-secret-with-at-least-thirty-two-bytes";
const guestSecret = "guest-secret-with-at-least-thirty-two-bytes";
let sequence = 0;

function coordinator(label: string) {
  const id = `${label}-${++sequence}-abcdefghijklmnop`;
  return { id, stub: env.ProjectCoordinatorV2.getByName(id) };
}

async function request(stub: DurableObjectStub<ProjectCoordinatorV2>, id: string, action: string, init: { credential?: string; body?: object; method?: string } = {}) {
  const response = await stub.fetch(`https://test/v2/projects/${id}/${action}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { ...(init.credential ? { Authorization: `Bearer ${init.credential}` } : {}), "content-type": "application/json" },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { response, body: await response.json<any>() };
}

async function bootstrap(label: string, paths: string[] = []) {
  const value = coordinator(label);
  const result = await request(value.stub, value.id, "bootstrap", { body: { projectInstanceId: value.id, hostSecret, paths, kind: "text" } });
  expect(result.response.status).toBe(201);
  return value;
}

async function mutate(stub: DurableObjectStub<ProjectCoordinatorV2>, id: string, action: string, revision: number, body: object = {}, credential = hostSecret) {
  return request(stub, id, action, { credential, body: { operationId: crypto.randomUUID(), expectedCatalogRevision: revision, ...body } });
}

async function secretHash(secret: string) {
  const salt = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${secret}`));
  return { salt, hash: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

describe("ProjectCoordinatorV2", () => {
  it("bootstraps once, validates routing and secrets, persists across restart, and requires auth", async () => {
    const bad = coordinator("bad");
    expect((await request(bad.stub, bad.id, "bootstrap", { body: { projectInstanceId: "different-abcdefghijkl", hostSecret } })).response.status).toBe(400);
    const weak = coordinator("weak");
    expect((await request(weak.stub, weak.id, "bootstrap", { body: { projectInstanceId: weak.id, hostSecret: "weak" } })).response.status).toBe(400);
    const { id, stub } = await bootstrap("persist", ["paper.md"]);
    expect((await request(stub, id, "catalog")).response.status).toBe(401);
    expect((await request(stub, id, "create", { body: {} })).response.status).toBe(401);
    await evictDurableObject(stub);
    const catalog = await request(stub, id, "catalog", { credential: hostSecret });
    expect(catalog.body.files[0].path).toBe("paper.md");
    expect((await request(stub, id, "bootstrap", { body: { projectInstanceId: id, hostSecret } })).response.status).toBe(409);
  });

  it("enforces permissions and revocation immediately without retaining plaintext secrets", async () => {
    const { id, stub } = await bootstrap("permissions");
    await mutate(stub, id, "import-finalize", 0);
    const grant = await mutate(stub, id, "grants", 1, { permission: "write", guestSecretHash: await secretHash(guestSecret) });
    expect(JSON.stringify(grant.body)).not.toContain(guestSecret);
    const grantId = grant.body.value.grantId;
    const listed = await request(stub, id, "grants", { credential: hostSecret });
    expect(listed.body).toEqual([{ grantId, permission: "write", revoked: false, authEpoch: 1 }]);
    expect(JSON.stringify(listed.body)).not.toContain("hash");
    expect((await request(stub, id, "grants", { credential: guestSecret })).response.status).toBe(403);
    expect((await mutate(stub, id, "close-begin", 2, {}, guestSecret)).response.status).toBe(403);
    expect((await mutate(stub, id, "create", 2, { path: "guest.md", kind: "text" }, guestSecret)).response.status).toBe(200);
    const readSecret = `${guestSecret}-read`;
    await mutate(stub, id, "grants", 3, { permission: "read", guestSecretHash: await secretHash(readSecret) });
    expect((await mutate(stub, id, "create", 4, { path: "read.md", kind: "text" }, readSecret)).response.status).toBe(403);
    await mutate(stub, id, "revoke", 4, { grantId });
    expect((await request(stub, id, "catalog", { credential: guestSecret })).response.status).toBe(401);
    const stored = await runInDurableObject(stub, async (_instance, state) => JSON.stringify(await state.storage.get("coordinator:v2")));
    expect(stored).not.toContain(guestSecret);
  });

  it("provides CAS and recursively canonical idempotency", async () => {
    const { id, stub } = await bootstrap("cas");
    await mutate(stub, id, "import-finalize", 0);
    const operationId = crypto.randomUUID();
    const firstBody = { operationId, expectedCatalogRevision: 1, path: "a.md", kind: "text", metadata: { z: 1, a: 2 } };
    const first = await request(stub, id, "create", { credential: hostSecret, body: firstBody });
    const retry = await request(stub, id, "create", { credential: hostSecret, body: { metadata: { a: 2, z: 1 }, path: "a.md", kind: "text", expectedCatalogRevision: 1, operationId } });
    expect(retry.body).toEqual(first.body);
    expect((await request(stub, id, "create", { credential: hostSecret, body: { ...firstBody, path: "b.md" } })).body.error).toBe("operation_id_reuse");
    expect((await mutate(stub, id, "create", 1, { path: "stale.md" })).body.error).toBe("catalog_revision_conflict");
  });

  it("preserves identity through rename and safely fences deletion and recreation", async () => {
    const { id, stub } = await bootstrap("delete", ["old.md"]);
    await mutate(stub, id, "import-finalize", 0);
    let catalog = await request(stub, id, "catalog", { credential: hostSecret });
    const fileId = catalog.body.files[0].fileId;
    expect(await stub.acknowledgeFileReady(fileId, 99)).toBe(false);
    expect(await stub.acknowledgeFileReady(fileId, 1)).toBe(true);
    const renamed = await mutate(stub, id, "rename", 2, { fileId, path: "new.md" });
    expect(renamed.body.value.fileId).toBe(fileId);
    expect((await mutate(stub, id, "delete-begin", 3, { fileId })).body.status).toBe("complete");
    expect(await stub.acknowledgeFileDeleted(fileId, 2)).toBe(false);
    expect(await stub.acknowledgeFileDeleted(fileId, 1)).toBe(true);
    expect(await stub.acknowledgeFileReady(fileId, 1)).toBe(false);
    const recreated = await mutate(stub, id, "create", 4, { path: "new.md", kind: "text" });
    expect(recreated.body.value.fileId).not.toBe(fileId);
  });

  it("closes only after every file fence ACK and denies tickets immediately", async () => {
    const { id, stub } = await bootstrap("close", ["a.md", "b.md"]);
    await mutate(stub, id, "import-finalize", 0);
    const catalog = await request(stub, id, "catalog", { credential: hostSecret });
    for (const file of catalog.body.files) await stub.acknowledgeFileReady(file.fileId, 1);
    const close = await mutate(stub, id, "close-begin", 3);
    expect(close.body.status).toBe("complete");
    expect((await request(stub, id, "tickets", { credential: hostSecret, body: { audience: "project" } })).response.status).toBe(409);
    expect(await stub.acknowledgeFileClosed(catalog.body.files[0].fileId, 2)).toBe(false);
    expect(await stub.acknowledgeFileClosed(catalog.body.files[0].fileId, 1)).toBe(true);
    expect(await stub.acknowledgeFileClosed(catalog.body.files[1].fileId, 1)).toBe(true);
    expect((await request(stub, id, "catalog", { credential: hostSecret })).body.lifecycle).toBe("closed");
  });

  it("issues bound one-use tickets and invalidates them on revoke and closing", async () => {
    const { id, stub } = await bootstrap("tickets", ["a.md"]);
    await mutate(stub, id, "import-finalize", 0);
    const catalog = await request(stub, id, "catalog", { credential: hostSecret });
    const fileId = catalog.body.files[0].fileId;
    await stub.acknowledgeFileReady(fileId, 1);
    const ticket = await request(stub, id, "tickets", { credential: hostSecret, body: { audience: "file", fileId } });
    expect(await stub.consumeSocketTicket(ticket.body.ticket, "file", "wrong")).toBeNull();
    expect(await stub.consumeSocketTicket(ticket.body.ticket, "file", fileId, 2)).toBeNull();
    const claims = await stub.consumeSocketTicket(ticket.body.ticket, "file", fileId);
    expect(claims).toMatchObject({ projectInstanceId: id, audience: "file", fileId, documentEpoch: 1, grantId: "host", permission: "host" });
    expect(await stub.consumeSocketTicket(ticket.body.ticket, "file", fileId)).toBeNull();
    const pending = await request(stub, id, "tickets", { credential: hostSecret, body: { audience: "project" } });
    await mutate(stub, id, "close-begin", 2);
    expect(await stub.consumeSocketTicket(pending.body.ticket, "project")).toBeNull();
  });

  it("invalidates an unconsumed guest ticket immediately after revocation", async () => {
    const { id, stub } = await bootstrap("revoked-ticket", ["a.md"]); await mutate(stub, id, "import-finalize", 0);
    const catalog = await request(stub, id, "catalog", { credential: hostSecret }); const fileId = catalog.body.files[0].fileId; await stub.acknowledgeFileReady(fileId, 1);
    const grant = await mutate(stub, id, "grants", 2, { permission: "write", guestSecretHash: await secretHash(guestSecret) });
    const ticket = await request(stub, id, "tickets", { credential: guestSecret, body: { audience: "file", fileId } });
    expect(await stub.authorizeTextMessage(id, fileId, 1, grant.body.value.grantId, 1, ticket.body.claims.projectAuthorityEpoch)).toBe(true);
    await mutate(stub, id, "revoke", 3, { grantId: grant.body.value.grantId });
    expect(await stub.consumeSocketTicket(ticket.body.ticket, "file", fileId, 1)).toBeNull();
    expect(await stub.authorizeTextMessage(id, fileId, 1, grant.body.value.grantId, 1, ticket.body.claims.projectAuthorityEpoch)).toBe(false);
    expect(await stub.authorizeTextMessage(id, fileId, 1, "host", 1, ticket.body.claims.projectAuthorityEpoch)).toBe(false);
    expect(await stub.authorizeTextMessage(id, fileId, 1, "host", 1, ticket.body.claims.projectAuthorityEpoch + 1)).toBe(true);
  });

  it("retains failed fence work with retry metadata and clears it on an idempotent callback", async () => {
    const { id, stub } = await bootstrap("fence-retry", ["a.md"]); await mutate(stub, id, "import-finalize", 0);
    const catalog = await request(stub, id, "catalog", { credential: hostSecret }); const fileId = catalog.body.files[0].fileId; await stub.acknowledgeFileReady(fileId, 1);
    await mutate(stub, id, "delete-begin", 2, { fileId });
    await runInDurableObject(stub, async (instance, state) => {
      const stored = await state.storage.get<any>("coordinator:v2");
      stored.pendingFileWork = [{ kind: "delete", fileId: "permanently-invalid-file", documentEpoch: 99 }];
      await state.storage.put("coordinator:v2", stored);
      (instance as any).state = stored;
      await instance.alarm();
    });
    const pending = await runInDurableObject(stub, async (_instance, state) => (await state.storage.get<any>("coordinator:v2")).pendingFileWork);
    expect(pending[0]).toMatchObject({ kind: "delete", fileId: "permanently-invalid-file", lastAttemptAt: expect.any(Number) });
    expect(pending[0].attempts).toBeGreaterThanOrEqual(1);
    await runInDurableObject(stub, async (instance, state) => {
      const stored = await state.storage.get<any>("coordinator:v2"); stored.pendingFileWork = [{ kind: "delete", fileId, documentEpoch: 1 }];
      await state.storage.put("coordinator:v2", stored); (instance as any).state = stored;
    });
    expect(await stub.acknowledgeFileDeleted(fileId, 1)).toBe(true);
    expect(await stub.acknowledgeFileDeleted(fileId, 1)).toBe(true);
    const cleared = await runInDurableObject(stub, async (_instance, state) => (await state.storage.get<any>("coordinator:v2")).pendingFileWork);
    expect(cleared).toEqual([]);
  });

  it("orders events and rejects path traversal, case collisions, and retention gaps", async () => {
    const { id, stub } = await bootstrap("events");
    await mutate(stub, id, "import-finalize", 0);
    await mutate(stub, id, "create", 1, { path: "Paper.md", kind: "text" });
    expect((await mutate(stub, id, "create", 2, { path: "paper.md", kind: "text" })).response.status).toBe(400);
    expect((await mutate(stub, id, "create", 2, { path: "../escape.md", kind: "text" })).response.status).toBe(400);
    const events = await request(stub, id, "events?since=0", { credential: hostSecret });
    expect(events.body.events.map((event: any) => event.catalogRevision)).toEqual([1, 2]);
    await runInDurableObject(stub, async (_instance, state) => {
      const value = await state.storage.get<any>("coordinator:v2");
      value.events = [{ catalogRevision: value.catalogRevision, type: "retained" }];
      await state.storage.put("coordinator:v2", value);
    });
    await evictDurableObject(stub);
    expect((await request(stub, id, "events?since=0", { credential: hostSecret })).body.refetch).toBe(true);
  });
});
