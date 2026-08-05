import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";

declare module "cloudflare:workers" { namespace Cloudflare { interface Env { ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2>; BinaryObjects: R2Bucket } } }

const secret = "gc-host-secret-with-at-least-thirty-two-bytes";
let sequence = 0;

async function createProject() {
  const id = `binary-gc-${++sequence}-abcdefghijklmnop`;
  await SELF.fetch(`https://worker/v2/projects/${id}/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectInstanceId: id, hostSecret: secret, paths: [], kind: "binary" }),
  });
  return { id, stub: env.ProjectCoordinatorV2.getByName(id) };
}

async function hostPost(id: string, path: string, body: object) {
  return SELF.fetch(`https://worker/v2/projects/${id}/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function completeRound(stub: DurableObjectStub<ProjectCoordinatorV2>, now: number) {
  let result: Awaited<ReturnType<ProjectCoordinatorV2["runBinaryGcForTest"]>>;
  do result = await stub.runBinaryGcForTest(now, 10); while (result.truncated);
  return result;
}

async function sha(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join(""); }

describe("binary GC durable double sweep", () => {
  it("deletes an unrooted object only after grace and two complete rounds", async () => {
    const { id, stub } = await createProject();
    const key = `v2/${id}/orphan/${"1".repeat(64)}`;
    await env.BinaryObjects.put(key, "orphan");
    const first = await completeRound(stub, 1_000);
    expect(first.round).toBe(2);
    expect(await env.BinaryObjects.head(key)).not.toBeNull();
    expect((await stub.runBinaryGcForTest(1_005, 10)).waitingForGrace).toBe(true);
    await completeRound(stub, 1_010);
    expect(await env.BinaryObjects.head(key)).toBeNull();
  });

  it("retains offline-recovery and migration-snapshot roots", async () => {
    const { id, stub } = await createProject();
    for (const [kind, digit] of [["offline-recovery", "2"], ["migration-snapshot", "3"]] as const) {
      const hash = digit.repeat(64); const fileId = `retained-${kind}`;
      await env.BinaryObjects.put(`v2/${id}/${fileId}/${hash}`, kind);
      expect((await hostPost(id, `binary/${kind}/pin`, { operationId: `pin-${kind}`, fileId, hash, ttlMs: 60_000 })).status).toBe(200);
    }
    await completeRound(stub, 2_000); await completeRound(stub, 2_010);
    expect((await env.BinaryObjects.list({ prefix: `v2/${id}/` })).objects).toHaveLength(2);
  });

  it("invalidates a paginated sweep when a root is added and resumes after a DO stub restart", async () => {
    const { id, stub } = await createProject();
    const keys: string[] = [];
    for (let index = 0; index < 101; index++) {
      const hash = index.toString(16).padStart(64, "0"); const key = `v2/${id}/file-${index.toString().padStart(3, "0")}/${hash}`;
      keys.push(key); await env.BinaryObjects.put(key, "candidate");
    }
    const page = await stub.runBinaryGcForTest(3_000, 10);
    expect(page.truncated).toBe(true);
    const [targetFile, targetHash] = keys[0]!.split("/").slice(-2);
    await hostPost(id, "binary/offline-recovery/pin", { operationId: "mid-page-pin", fileId: targetFile, hash: targetHash, ttlMs: 60_000 });
    const restartedStub = env.ProjectCoordinatorV2.getByName(id);
    await completeRound(restartedStub, 3_001); await completeRound(restartedStub, 3_011);
    expect(await env.BinaryObjects.head(keys[0]!)).not.toBeNull();
    expect((await env.BinaryObjects.list({ prefix: `v2/${id}/` })).objects).toHaveLength(1);
  });

  it("uses an exact project prefix and never lists or deletes another project's object", async () => {
    const { id, stub } = await createProject();
    const otherKey = `v2/${id}-other/file/${"4".repeat(64)}`;
    await env.BinaryObjects.put(otherKey, "other");
    expect((await completeRound(stub, 4_000)).scanned).toBe(0);
    await completeRound(stub, 4_010);
    expect(await env.BinaryObjects.head(otherKey)).not.toBeNull();
  });

  it("does not park in round 2 when a sweep finds no candidates", async () => {
    const { id, stub } = await createProject();
    expect((await completeRound(stub, 1_000)).round).toBe(1);
    // An orphan appearing afterwards (without any root-generation bump) must
    // still be collected instead of the sweep waiting forever on a stamped
    // candidate that does not exist.
    const key = `v2/${id}/late/${"5".repeat(64)}`;
    await env.BinaryObjects.put(key, "late-orphan");
    expect((await completeRound(stub, 2_000)).round).toBe(2);
    await completeRound(stub, 2_010);
    expect(await env.BinaryObjects.head(key)).toBeNull();
  });

  it("collects an uploaded-but-never-committed object once its ticket expires", async () => {
    const id = `binary-gc-${++sequence}-abcdefghijklmnop`;
    await SELF.fetch(`https://worker/v2/projects/${id}/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectInstanceId: id, hostSecret: secret, paths: ["figure.pdf"], kind: "binary" }) });
    await hostPost(id, "import-finalize", { operationId: crypto.randomUUID(), expectedCatalogRevision: 0 });
    const catalog = await (await SELF.fetch(`https://worker/v2/projects/${id}/catalog`, { headers: { Authorization: `Bearer ${secret}` } })).json<any>();
    const fileId = catalog.files[0].fileId;
    const stub = env.ProjectCoordinatorV2.getByName(id);
    await stub.acknowledgeFileReady(fileId, 1);
    const bytes = new TextEncoder().encode("stale upload");
    const hash = await sha(bytes);
    const t0 = Date.now();
    const issued = await (await hostPost(id, "binary/upload-tickets", { fileId, documentEpoch: 1, declaredHash: hash, declaredSize: bytes.length, contentType: "application/pdf", expectedCatalogRevision: 2, expectedContentRevision: 0, operationId: crypto.randomUUID() })).json<any>();
    const upload = await SELF.fetch(`https://worker/v2/projects/${id}/binary/uploads/${issued.ticket}`, { method: "PUT", headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes });
    expect(upload.status).toBe(201);
    const key = `v2/${id}/${fileId}/${hash}`;
    // While the ticket is valid the uncommitted object stays rooted.
    await completeRound(stub, t0 + 1_000);
    expect(await env.BinaryObjects.head(key)).not.toBeNull();
    // After expiry the object can never be committed, so GC picks it up even
    // though nothing bumps the root generation.
    expect((await completeRound(stub, t0 + 61_000)).round).toBe(2);
    await completeRound(stub, t0 + 61_010);
    expect(await env.BinaryObjects.head(key)).toBeNull();
  });
});
