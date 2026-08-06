import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";
import { textFileV2RoomName, type TextFileV2 } from "../src/text-file-v2";

declare module "cloudflare:workers" {
  namespace Cloudflare { interface Env { ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2>; TextFileV2: DurableObjectNamespace<TextFileV2>; BinaryObjects: R2Bucket } }
}

const secret = "lifecycle-host-secret-thirty-two-bytes";
let sequence = 0;
const STATE_KEY = "coordinator:v2";

async function hostPost(id: string, path: string, body: object, credential: string | null = secret) {
  return SELF.fetch(`https://worker/v2/projects/${id}/${path}`, {
    method: "POST", headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function textProject(paths: string[] = ["paper.md"]) {
  const id = `lifecycle-${++sequence}-abcdefghijklmnop`;
  await hostPost(id, "bootstrap", { projectInstanceId: id, hostSecret: secret, paths, kind: "text" }, null);
  await hostPost(id, "import-finalize", { operationId: crypto.randomUUID(), expectedCatalogRevision: 0 });
  const catalog = await (await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).json<any>();
  const stub = env.ProjectCoordinatorV2.getByName(id);
  return { id, stub, catalog };
}

async function binaryProject() {
  const id = `lifecycle-${++sequence}-abcdefghijklmnop`;
  await hostPost(id, "bootstrap", { projectInstanceId: id, hostSecret: secret, paths: ["figure.pdf"], kind: "binary" }, null);
  await hostPost(id, "import-finalize", { operationId: crypto.randomUUID(), expectedCatalogRevision: 0 });
  const catalog = await (await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).json<any>();
  const stub = env.ProjectCoordinatorV2.getByName(id);
  await stub.acknowledgeFileReady(catalog.files[0].fileId, 1);
  return { id, stub, fileId: catalog.files[0].fileId as string };
}

async function sha(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join(""); }
async function guestSecretHash(secret: string) { const salt = "p".repeat(43); return { salt, hash: await sha(new TextEncoder().encode(`${salt}:${secret}`)) }; }

async function readState(id: string): Promise<any> {
  return runInDurableObject(env.ProjectCoordinatorV2.getByName(id), async (_instance, state) => state.storage.get(STATE_KEY));
}

describe("v2 browser access", () => {
  it("answers preflight and includes CORS headers on project responses", async () => {
    const id = `cors-${++sequence}-abcdefghijklmnop`;
    const preflight = await SELF.fetch(`https://worker/v2/projects/${id}/bootstrap`, {
      method: "OPTIONS",
      headers: {
        Origin: "tauri://localhost",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization, content-length, content-type, x-content-sha256, x-document-epoch, x-operation-id",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-length");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-operation-id");

    const response = await hostPost(id, "bootstrap", { projectInstanceId: id, hostSecret: secret, paths: [], kind: "text" }, null);
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("v2 project presence channel", () => {
  it("announces, lists, prunes stale entries, supports leave, and requires auth", async () => {
    const { id, stub } = await textProject();
    expect((await hostPost(id, "presence", { instanceId: "a" }, null)).status).toBe(401);
    const first = await (await hostPost(id, "presence", { instanceId: "a", name: " Ada ", color: "#fff", path: "paper.md" })).json<any>();
    expect(first.presence.a).toMatchObject({ name: "Ada", color: "#fff", path: "paper.md" });
    const second = await (await hostPost(id, "presence", { instanceId: "b", name: "Bo", color: "#000", path: null })).json<any>();
    expect(Object.keys(second.presence).sort()).toEqual(["a", "b"]);
    expect(second.presence.b.path).toBeNull();
    // An entry past the presence TTL disappears on the next heartbeat.
    await stub.seedPresenceForTest("stale", { name: "Ghost", color: "#123", path: "x.md", updatedAt: Date.now() - 120_000 });
    const third = await (await hostPost(id, "presence", { instanceId: "a", name: "Ada", color: "#fff", path: "paper.md" })).json<any>();
    expect(third.presence.stale).toBeUndefined();
    const left = await (await hostPost(id, "presence", { instanceId: "b", leave: true })).json<any>();
    expect(left.presence.b).toBeUndefined();
    expect(left.presence.a).toBeDefined();
  });

  it("stamps every entry with the authenticated permission, visibly to guests and unspoofable", async () => {
    const { id } = await textProject();
    const guestSecret = "permission-guest-secret-with-thirty-two-bytes";
    await hostPost(id, "grants", { operationId: crypto.randomUUID(), expectedCatalogRevision: 1, permission: "write", guestSecretHash: await guestSecretHash(guestSecret) });
    await hostPost(id, "presence", { instanceId: "host-instance", name: "Ada", color: "#456", path: "paper.md" });
    // A guest claiming to be the host is recorded as the guest it authenticated as.
    const guestView = await (await hostPost(id, "presence", { instanceId: "guest-instance", name: "Bo", color: "#123", path: "paper.md", permission: "host" }, guestSecret)).json<any>();
    expect(guestView.presence["guest-instance"].permission).toBe("write");
    // Unlike grantId, the permission stays visible to guests: it is how they
    // tell who started the share.
    expect(guestView.presence["host-instance"].permission).toBe("host");
  });

  it("shows grant ownership only to the host and removes matching presence on revoke", async () => {
    const { id } = await textProject();
    const guestSecret = "presence-guest-secret-with-thirty-two-bytes";
    const grant = await (await hostPost(id, "grants", { operationId: crypto.randomUUID(), expectedCatalogRevision: 1, permission: "write", guestSecretHash: await guestSecretHash(guestSecret) })).json<any>();
    const grantId = grant.value.grantId as string;
    const guestView = await (await hostPost(id, "presence", { instanceId: "guest-instance", name: "Bo", color: "#123", path: "paper.md" }, guestSecret)).json<any>();
    expect(guestView.presence["guest-instance"].grantId).toBeUndefined();
    const hostView = await (await hostPost(id, "presence", { instanceId: "host-instance", name: "Ada", color: "#456", path: "paper.md" })).json<any>();
    expect(hostView.presence["guest-instance"].grantId).toBe(grantId);
    const otherGuestSecret = "other-presence-guest-secret-with-thirty-two-bytes";
    await hostPost(id, "grants", { operationId: crypto.randomUUID(), expectedCatalogRevision: 2, permission: "write", guestSecretHash: await guestSecretHash(otherGuestSecret) });
    expect((await hostPost(id, "presence", { instanceId: "guest-instance", name: "Mallory" }, otherGuestSecret)).status).toBe(403);
    await hostPost(id, "presence", { instanceId: "guest-instance", leave: true }, otherGuestSecret);
    const afterUnauthorizedLeave = await (await hostPost(id, "presence", { instanceId: "host-instance", name: "Ada", color: "#456", path: "paper.md" })).json<any>();
    expect(afterUnauthorizedLeave.presence["guest-instance"]).toBeDefined();
    await hostPost(id, "revoke", { operationId: crypto.randomUUID(), expectedCatalogRevision: 3, grantId });
    const after = await (await hostPost(id, "presence", { instanceId: "host-instance", name: "Ada", color: "#456", path: "paper.md" })).json<any>();
    expect(after.presence["guest-instance"]).toBeUndefined();
  });
});

describe("v2 idle project TTL", () => {
  it("reclaims coordinator, file DO, and R2 storage after the idle TTL", async () => {
    const { id, stub, catalog } = await textProject();
    const fileId = catalog.files[0].fileId;
    const room = textFileV2RoomName(id, fileId, 1);
    await runInDurableObject(env.TextFileV2.getByName(room), async (_instance, state) => state.storage.put("marker", 1));
    const key = `v2/${id}/bin/${"9".repeat(64)}`;
    await env.BinaryObjects.put(key, "binary");
    await stub.setLastActivityForTest(Date.now() - 31 * 24 * 60 * 60_000);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect((await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404);
    expect(await readState(id)).toBeUndefined();
    expect(await env.BinaryObjects.head(key)).toBeNull();
    expect(await runInDurableObject(env.TextFileV2.getByName(room), async (_instance, state) => state.storage.get("marker"))).toBeUndefined();
  });

  it("keeps an active project alive because authenticated requests refresh activity", async () => {
    const { id, stub } = await textProject();
    await stub.setLastActivityForTest(Date.now() - 31 * 24 * 60 * 60_000);
    expect((await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(200);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await readState(id)).toBeDefined();
    expect((await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(200);
  });
});

describe("v2 idempotency log retention", () => {
  it("prunes the operations log on the binary commit path too", async () => {
    const { id, stub, fileId } = await binaryProject();
    await stub.seedOperationsForTest(512);
    const bytes = new TextEncoder().encode("pdf");
    const operationId = "commit-after-seed";
    const issued = await (await hostPost(id, "binary/upload-tickets", { fileId, documentEpoch: 1, declaredHash: await sha(bytes), declaredSize: bytes.length, contentType: "application/pdf", expectedCatalogRevision: 2, expectedContentRevision: 0, operationId })).json<any>();
    await SELF.fetch(`https://worker/v2/projects/${id}/binary/uploads/${issued.ticket}`, { method: "PUT", headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes });
    expect((await hostPost(id, "binary/commit", { ticket: issued.ticket, operationId })).status).toBe(200);
    const state = await readState(id);
    expect(state.operationOrder).toHaveLength(512);
    expect(state.operationOrder.at(-1)).toBe(operationId);
    expect(state.operationOrder[0]).toBe("seed-1");
    expect(state.operations["seed-0"]).toBeUndefined();
    expect(Object.keys(state.operations)).toHaveLength(512);
  });
});

describe("v2 deleted file content reclamation", () => {
  it("wipes file DO content after the coordinator accepts the deletion ack, keeping the tombstone", async () => {
    const { id, stub, catalog } = await textProject();
    const fileId = catalog.files[0].fileId;
    await stub.acknowledgeFileReady(fileId, 1);
    const room = textFileV2RoomName(id, fileId, 1);
    const fileStub = env.TextFileV2.getByName(room);
    await runInDurableObject(fileStub, async (instance) => {
      await instance.onLoad();
      instance.document.getText("content").insert(0, "doomed");
      await instance.onSave();
    });
    expect(await runInDurableObject(fileStub, async (_instance, state) => state.storage.get("text-v2:snapshot:head"))).toBeDefined();
    await hostPost(id, "delete-begin", { operationId: crypto.randomUUID(), expectedCatalogRevision: 2, fileId });
    await runInDurableObject(fileStub, async (instance) => instance.onAlarm());
    const keys = await runInDurableObject(fileStub, async (_instance, state) => [...(await state.storage.list()).keys()]);
    expect(keys.sort()).toEqual(["text-v2:authority", "text-v2:identity"]);
    const identity = await runInDurableObject(fileStub, async (_instance, state) => state.storage.get<any>("text-v2:identity"));
    expect(identity.fenced).toBe("deleted");
    // The tombstone still rejects reconnects instead of reborn empty documents.
    const response = await fileStub.fetch("https://room/", { headers: { Upgrade: "websocket", "x-lattice-project": id, "x-lattice-file": fileId, "x-lattice-epoch": "1", "x-lattice-permission": "host" } });
    expect(response.status).toBe(410);
  });
});
