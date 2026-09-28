import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { textFileV2RoomName } from "../../protocol/collab-v2";
import { createProject, guestSecretHash, HOST_SECRET, projectId, putBinary, request, storedState, storedValue, upgradeHeaders, uploadTicket } from "./harness";

const PAST_IDLE_TTL_MS = 31 * 24 * 60 * 60_000;

describe("v2 browser access", () => {
  it("answers preflight and includes CORS headers on project responses", async () => {
    const id = projectId("cors");
    const requested = { Origin: "tauri://localhost", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization, content-length, content-type, x-content-sha256, x-document-epoch, x-operation-id" };
    const preflight = await SELF.fetch(`https://worker/v2/projects/${id}/bootstrap`, { method: "OPTIONS", headers: requested });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-length");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-operation-id");
    const response = await request(SELF, id, "bootstrap", { credential: null, body: { projectInstanceId: id, hostSecret: HOST_SECRET, paths: [], kind: "text" } });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("v2 project presence channel", () => {
  const paperProject = (label: string) => createProject(label, { paths: ["paper.md"] });
  type Project = Awaited<ReturnType<typeof paperProject>>;
  const heartbeat = async (project: Project, body: object, credential?: string) => (await project.call("presence", { body, credential })).body.presence;
  const addWriter = async (project: Project, revision: number, secret: string) => (await project.mutate("grants", revision, { permission: "write", guestSecretHash: await guestSecretHash(secret) })).body.value.grantId as string;

  it("announces, lists, prunes stale entries, supports leave, and requires auth", async () => {
    const project = await paperProject("presence");
    expect((await project.call("presence", { credential: null, body: { instanceId: "a" } })).status).toBe(401);
    expect((await heartbeat(project, { instanceId: "a", name: " Ada ", color: "#fff", path: "paper.md" })).a).toMatchObject({ name: "Ada", color: "#fff", path: "paper.md" });
    const second = await heartbeat(project, { instanceId: "b", name: "Bo", color: "#000", path: null });
    expect(Object.keys(second).sort()).toEqual(["a", "b"]);
    expect(second.b.path).toBeNull();
    // An entry past the presence TTL disappears on the next heartbeat.
    await project.stub.seedPresenceForTest("stale", { name: "Ghost", color: "#123", path: "x.md", updatedAt: Date.now() - 120_000 });
    expect((await heartbeat(project, { instanceId: "a", name: "Ada", color: "#fff", path: "paper.md" })).stale).toBeUndefined();
    const left = await heartbeat(project, { instanceId: "b", leave: true });
    expect(left.b).toBeUndefined();
    expect(left.a).toBeDefined();
  });

  it("stamps every entry with the authenticated permission, visibly to guests and unspoofable", async () => {
    const project = await paperProject("presence-permission");
    const guestSecret = "permission-guest-secret-with-thirty-two-bytes";
    await addWriter(project, 1, guestSecret);
    await heartbeat(project, { instanceId: "host-instance", name: "Ada", color: "#456", path: "paper.md" });
    // A guest claiming to be the host is recorded as the guest it authenticated as.
    const guestView = await heartbeat(project, { instanceId: "guest-instance", name: "Bo", color: "#123", path: "paper.md", permission: "host" }, guestSecret);
    expect(guestView["guest-instance"].permission).toBe("write");
    // Unlike grantId, the permission stays visible to guests: it is how they
    // tell who started the share.
    expect(guestView["host-instance"].permission).toBe("host");
  });

  it("shows grant ownership only to the host and removes matching presence on revoke", async () => {
    const project = await paperProject("presence-owner");
    const guestSecret = "presence-guest-secret-with-thirty-two-bytes";
    const grantId = await addWriter(project, 1, guestSecret);
    const hostBeat = () => heartbeat(project, { instanceId: "host-instance", name: "Ada", color: "#456", path: "paper.md" });
    expect((await heartbeat(project, { instanceId: "guest-instance", name: "Bo", color: "#123", path: "paper.md" }, guestSecret))["guest-instance"].grantId).toBeUndefined();
    expect((await hostBeat())["guest-instance"].grantId).toBe(grantId);
    const otherGuestSecret = "other-presence-guest-secret-with-thirty-two-bytes";
    await addWriter(project, 2, otherGuestSecret);
    expect((await project.call("presence", { body: { instanceId: "guest-instance", name: "Mallory" }, credential: otherGuestSecret })).status).toBe(403);
    await heartbeat(project, { instanceId: "guest-instance", leave: true }, otherGuestSecret);
    expect((await hostBeat())["guest-instance"]).toBeDefined();
    await project.mutate("revoke", 3, { grantId });
    expect((await hostBeat())["guest-instance"]).toBeUndefined();
  });
});

describe("v2 idle project TTL", () => {
  it("reclaims coordinator, file DO, and R2 storage after the idle TTL", async () => {
    const { id, stub, fileId, call } = await createProject("idle", { paths: ["paper.md"] });
    const room = env.TextFileV2.getByName(textFileV2RoomName(id, fileId, 1));
    await runInDurableObject(room, async (_instance, state) => state.storage.put("marker", 1));
    const key = `v2/${id}/bin/${"9".repeat(64)}`;
    await env.BinaryObjects.put(key, "binary");
    await stub.setLastActivityForTest(Date.now() - PAST_IDLE_TTL_MS);
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect((await call("catalog")).status).toBe(404);
    expect(await storedState(stub)).toBeUndefined();
    expect(await env.BinaryObjects.head(key)).toBeNull();
    expect(await storedValue(room, "marker")).toBeUndefined();
  });

  it("keeps an active project alive because authenticated requests refresh activity", async () => {
    const { stub, call } = await createProject("active", { paths: ["paper.md"] });
    await stub.setLastActivityForTest(Date.now() - PAST_IDLE_TTL_MS);
    expect((await call("catalog")).status).toBe(200);
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(await storedState(stub)).toBeDefined();
    expect((await call("catalog")).status).toBe(200);
  });
});

describe("v2 idempotency log retention", () => {
  it("prunes the operations log on the binary commit path too", async () => {
    const { id, stub, fileId, call } = await createProject("retention", { kind: "binary", paths: ["figure.pdf"], ready: true });
    await stub.seedOperationsForTest(512);
    const bytes = new TextEncoder().encode("pdf");
    const operationId = "commit-after-seed";
    const { ticket } = await uploadTicket(id, fileId, bytes, { operationId });
    await putBinary(id, ticket, bytes);
    expect((await call("binary/commit", { body: { ticket, operationId } })).status).toBe(200);
    const state = await storedState(stub);
    expect(state.operationOrder).toHaveLength(512);
    expect(state.operationOrder.at(-1)).toBe(operationId);
    expect(state.operationOrder[0]).toBe("seed-1");
    expect(state.operations["seed-0"]).toBeUndefined();
    expect(Object.keys(state.operations)).toHaveLength(512);
  });
});

describe("v2 deleted file content reclamation", () => {
  it("wipes file DO content after the coordinator accepts the deletion ack, keeping the tombstone", async () => {
    const { id, fileId, mutate } = await createProject("wipe", { paths: ["paper.md"], ready: true });
    const room = env.TextFileV2.getByName(textFileV2RoomName(id, fileId, 1));
    await runInDurableObject(room, async (instance) => {
      await instance.onLoad();
      instance.document.getText("content").insert(0, "doomed");
      await instance.onSave();
    });
    expect(await storedValue(room, "text-v2:snapshot:head")).toBeDefined();
    await mutate("delete-begin", 2, { fileId });
    await runInDurableObject(room, (instance) => instance.onAlarm());
    const keys = await runInDurableObject(room, async (_instance, state) => [...(await state.storage.list()).keys()]);
    expect(keys.sort()).toEqual(["text-v2:authority", "text-v2:identity"]);
    expect((await storedValue(room, "text-v2:identity")).fenced).toBe("deleted");
    // The tombstone still rejects reconnects instead of reborn empty documents.
    expect((await room.fetch("https://room/", { headers: upgradeHeaders(id, fileId) })).status).toBe(410);
  });
});
