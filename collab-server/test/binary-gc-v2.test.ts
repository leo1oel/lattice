import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/encoding";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";
import { createProject, putBinary, uploadTicket } from "./harness";

const emptyProject = () => createProject("binary-gc", { kind: "binary", finalize: false });
const listed = async (id: string) => (await env.BinaryObjects.list({ prefix: `v2/${id}/` })).objects;

/** Runs sweep pages at `now` (with a 10 ms grace) until the round's listing is complete. */
async function completeRound(stub: DurableObjectStub<ProjectCoordinatorV2>, now: number) {
  let result: Awaited<ReturnType<ProjectCoordinatorV2["runBinaryGcForTest"]>>;
  do result = await stub.runBinaryGcForTest(now, 10); while (result.truncated);
  return result;
}

describe("binary GC durable double sweep", () => {
  it("deletes an unrooted object only after grace and two complete rounds", async () => {
    const { id, stub } = await emptyProject();
    const key = `v2/${id}/orphan/${"1".repeat(64)}`;
    await env.BinaryObjects.put(key, "orphan");
    expect((await completeRound(stub, 1_000)).round).toBe(2);
    expect(await env.BinaryObjects.head(key)).not.toBeNull();
    expect((await stub.runBinaryGcForTest(1_005, 10)).waitingForGrace).toBe(true);
    await completeRound(stub, 1_010);
    expect(await env.BinaryObjects.head(key)).toBeNull();
  });

  it("retains offline-recovery and migration-snapshot roots", async () => {
    const { id, stub, call } = await emptyProject();
    for (const [kind, digit] of [["offline-recovery", "2"], ["migration-snapshot", "3"]] as const) {
      const hash = digit.repeat(64);
      const fileId = `retained-${kind}`;
      await env.BinaryObjects.put(`v2/${id}/${fileId}/${hash}`, kind);
      expect((await call(`binary/${kind}/pin`, { body: { operationId: `pin-${kind}`, fileId, hash, ttlMs: 60_000 } })).status).toBe(200);
    }
    await completeRound(stub, 2_000);
    await completeRound(stub, 2_010);
    expect(await listed(id)).toHaveLength(2);
  });

  it("invalidates a paginated sweep when a root is added and resumes after a DO stub restart", async () => {
    const { id, stub, call } = await emptyProject();
    const keys: string[] = [];
    for (let index = 0; index < 101; index++) {
      const key = `v2/${id}/file-${index.toString().padStart(3, "0")}/${index.toString(16).padStart(64, "0")}`;
      keys.push(key);
      await env.BinaryObjects.put(key, "candidate");
    }
    expect((await stub.runBinaryGcForTest(3_000, 10)).truncated).toBe(true);
    const [targetFile, targetHash] = keys[0]!.split("/").slice(-2);
    await call("binary/offline-recovery/pin", { body: { operationId: "mid-page-pin", fileId: targetFile, hash: targetHash, ttlMs: 60_000 } });
    const restartedStub = env.ProjectCoordinatorV2.getByName(id);
    await completeRound(restartedStub, 3_001);
    await completeRound(restartedStub, 3_011);
    expect(await env.BinaryObjects.head(keys[0]!)).not.toBeNull();
    expect(await listed(id)).toHaveLength(1);
  });

  it("uses an exact project prefix and never lists or deletes another project's object", async () => {
    const { id, stub } = await emptyProject();
    const otherKey = `v2/${id}-other/file/${"4".repeat(64)}`;
    await env.BinaryObjects.put(otherKey, "other");
    expect((await completeRound(stub, 4_000)).scanned).toBe(0);
    await completeRound(stub, 4_010);
    expect(await env.BinaryObjects.head(otherKey)).not.toBeNull();
  });

  it("does not park in round 2 when a sweep finds no candidates", async () => {
    const { id, stub } = await emptyProject();
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
    const { id, stub, fileId } = await createProject("binary-gc", { kind: "binary", paths: ["figure.pdf"], ready: true });
    const bytes = new TextEncoder().encode("stale upload");
    const t0 = Date.now();
    const { ticket } = await uploadTicket(id, fileId, bytes);
    expect((await putBinary(id, ticket, bytes)).status).toBe(201);
    const key = `v2/${id}/${fileId}/${await sha256Hex(bytes)}`;
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
