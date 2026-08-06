import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc } from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { AUTH_CACHE_MS, AUTH_OUTAGE_LEEWAY_MS, MAX_AWARENESS_PER_MINUTE, MAX_FRAMES_PER_MINUTE, MAX_UPDATES_PER_MINUTE, parseTextFileV2RoomName, textFileV2RoomName, type TextFileV2 } from "../src/text-file-v2";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";

declare module "cloudflare:workers" {
  namespace Cloudflare { interface Env { TextFileV2: DurableObjectNamespace<TextFileV2>; ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2> } }
}

const hostSecret = "host-secret-with-at-least-thirty-two-bytes";
let sequence = 0;

async function liveFile(permission: "host" | "read" = "host") {
  const projectInstanceId = `text-v2-${++sequence}-abcdefghijklmnop`;
  const coordinator = env.ProjectCoordinatorV2.getByName(projectInstanceId);
  await coordinator.fetch(`https://test/v2/projects/${projectInstanceId}/bootstrap`, { method: "POST", body: JSON.stringify({ projectInstanceId, hostSecret, paths: ["paper.md"], kind: "text" }) });
  await coordinator.fetch(`https://test/v2/projects/${projectInstanceId}/import-finalize`, { method: "POST", headers: { Authorization: `Bearer ${hostSecret}` }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedCatalogRevision: 0 }) });
  const catalog = await (await coordinator.fetch(`https://test/v2/projects/${projectInstanceId}/catalog`, { headers: { Authorization: `Bearer ${hostSecret}` } })).json<any>();
  const file = catalog.files[0];
  await coordinator.acknowledgeFileReady(file.fileId, file.documentEpoch);
  let credential = hostSecret;
  if (permission === "read") {
    credential = "read-secret-with-at-least-thirty-two-bytes";
    await coordinator.fetch(`https://test/v2/projects/${projectInstanceId}/grants`, { method: "POST", headers: { Authorization: `Bearer ${hostSecret}` }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedCatalogRevision: 2, permission: "read", guestSecret: credential }) });
  }
  const ticket = await (await coordinator.fetch(`https://test/v2/projects/${projectInstanceId}/tickets`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ audience: "file", fileId: file.fileId }) })).json<any>();
  const room = textFileV2RoomName(projectInstanceId, file.fileId, file.documentEpoch);
  return { projectInstanceId, coordinator, file, room, ticket: ticket.ticket };
}

function wsUrl(room: string, ticket?: string) { return `https://test/parties/text-file-v2/${room}${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`; }

function testConnection(permission: "host" | "read" = "host") {
  const closed: Array<[number, string]> = [];
  const connection = { state: { grantId: "host", permission, grantEpoch: 1, projectAuthorityEpoch: 1, windowAt: Date.now(), frames: 0, updates: 0, awareness: 0 }, setState(next: any) { this.state = next; }, close(code: number, reason: string) { closed.push([code, reason]); }, send() {} } as any;
  return { connection, closed };
}

describe("TextFileV2 data plane", () => {
  it("uses a canonical, validated identity room", () => {
    const room = textFileV2RoomName("project-abcdefghijkl", "file-id-abcdefghijkl", 7);
    expect(parseTextFileV2RoomName(room)).toMatchObject({ projectInstanceId: "project-abcdefghijkl", fileId: "file-id-abcdefghijkl", documentEpoch: 7 });
    expect(parseTextFileV2RoomName(`${room}x`)).toBeNull();
  });

  it("gates upgrade with an exact one-use ticket", async () => {
    const value = await liveFile();
    expect((await SELF.fetch(wsUrl(value.room), { headers: { Upgrade: "websocket" } })).status).toBe(401);
    expect((await SELF.fetch(wsUrl(value.room, value.ticket), { headers: { Upgrade: "websocket" } })).status).toBe(101);
    expect((await SELF.fetch(wsUrl(value.room, value.ticket), { headers: { Upgrade: "websocket" } })).status).toBe(403);
  });

  it("durably initializes a live-project text file before publishing it", async () => {
    const projectInstanceId = `text-seed-${++sequence}-abcdefghijklmnop`;
    const coordinator = env.ProjectCoordinatorV2.getByName(projectInstanceId);
    const controlUrl = `https://test/v2/projects/${projectInstanceId}`;
    await coordinator.fetch(`${controlUrl}/bootstrap`, { method: "POST", body: JSON.stringify({ projectInstanceId, hostSecret }) });
    await coordinator.fetch(`${controlUrl}/import-finalize`, { method: "POST", headers: { Authorization: `Bearer ${hostSecret}`, "content-type": "application/json" }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedCatalogRevision: 0 }) });
    const bytes = new TextEncoder().encode("# Durable first\n");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const operationId = "initialize_durable_first";
    const createdResponse = await coordinator.fetch(`${controlUrl}/create`, { method: "POST", headers: { Authorization: `Bearer ${hostSecret}`, "content-type": "application/json" }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedCatalogRevision: 1, path: "new.md", kind: "text", initializer: { operationId, size: bytes.byteLength, hash } }) });
    const file = (await createdResponse.json<any>()).value;

    let catalog = await (await coordinator.fetch(`${controlUrl}/catalog`, { headers: { Authorization: `Bearer ${hostSecret}` } })).json<any>();
    expect(catalog.files[0].state).toBe("initializing");
    const upload = () => SELF.fetch(`${controlUrl}/text/imports/${file.fileId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${hostSecret}`, "content-length": String(bytes.byteLength), "x-document-epoch": "1", "x-content-sha256": hash, "x-operation-id": operationId },
      body: bytes,
    });
    expect((await upload()).status).toBe(201);

    catalog = await (await coordinator.fetch(`${controlUrl}/catalog`, { headers: { Authorization: `Bearer ${hostSecret}` } })).json<any>();
    expect(catalog.files[0]).toMatchObject({ state: "live", size: bytes.byteLength, hash });
    const room = textFileV2RoomName(projectInstanceId, file.fileId, 1);
    expect(await runInDurableObject(env.TextFileV2.getByName(room), async (instance) => {
      await instance.onLoad();
      return instance.document.getText("content").toString();
    })).toBe("# Durable first\n");
    expect((await upload()).status).toBe(200);
  });

  it("persists immutable generations, caches metadata, and recovers the previous generation", async () => {
    const value = await liveFile();
    const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onLoad(); instance.document.getText("content").insert(0, "old"); await instance.onSave();
      instance.document.getText("content").insert(3, " new"); await instance.onSave();
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      await state.storage.delete(`text-v2:snapshot:chunk:${head.current.generation}:0`);
    });
    await evictDurableObject(stub);
    expect(await runInDurableObject(stub, async (instance) => { await instance.onLoad(); return instance.document.getText("content").toString(); })).toBe("old");
    const catalog = await (await value.coordinator.fetch(`https://test/v2/projects/${value.projectInstanceId}/catalog`, { headers: { Authorization: `Bearer ${hostSecret}` } })).json<any>();
    expect(catalog.files[0]).toMatchObject({ contentRevision: 2, hash: expect.any(String), size: expect.any(Number) });
  });

  it("fails closed when current and previous generations are corrupt", async () => {
    const value = await liveFile();
    const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onLoad(); instance.document.getText("content").insert(0, "one"); await instance.onSave();
      instance.document.getText("content").insert(3, " two"); await instance.onSave();
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      await state.storage.delete(`text-v2:snapshot:chunk:${head.current.generation}:0`);
      await state.storage.delete(`text-v2:snapshot:chunk:${head.previous.generation}:0`);
    });
    await evictDurableObject(stub);
    await expect(runInDurableObject(stub, (instance) => instance.onLoad())).rejects.toThrow("corrupt_snapshot");
  });

  it.each([
    ["generation", 0], ["contentRevision", -1], ["chunkCount", 0], ["byteLength", 0],
    ["sha256", "nope"], ["documentEpoch", 0],
  ])("rejects a manifest with invalid %s", async (field, invalid) => {
    const value = await liveFile(); const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onLoad(); instance.document.getText("content").insert(0, "valid"); await instance.onSave();
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      const manifest = await state.storage.get<any>(`text-v2:snapshot:manifest:${head.current.generation}`);
      manifest[field] = invalid;
      await state.storage.put(`text-v2:snapshot:manifest:${head.current.generation}`, manifest);
    });
    await evictDurableObject(stub);
    await expect(runInDurableObject(stub, (instance) => instance.onLoad())).rejects.toThrow("corrupt_snapshot");
  });

  it("publishes the pointer before emitting the exact durable custom ACK", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance, state) => {
      await instance.onLoad(); instance.document.getText("content").insert(0, "ack");
      let pointerPublished = false; let payload = "";
      const originalPut = state.storage.put.bind(state.storage);
      state.storage.put = (async (key: any, stored: any, options?: any) => {
        if (key === "text-v2:snapshot:head") pointerPublished = true;
        return originalPut(key, stored, options);
      }) as any;
      instance.broadcastCustomMessage = ((message: string) => { expect(pointerPublished).toBe(true); payload = message; }) as any;
      await instance.onSave();
      expect(JSON.parse(payload)).toEqual({ type: "lattice.durable-ack", protocol: 2, projectInstanceId: value.projectInstanceId, fileId: value.file.fileId, documentEpoch: 1, contentRevision: 1, snapshotGeneration: 1, stateVector: expect.any(String), size: expect.any(Number), hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    });
  });

  it("keeps only the complete current and previous generations after repeated saves", async () => {
    const value = await liveFile(); const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async (instance) => {
      await instance.onLoad();
      for (const text of ["a", "b", "c", "d", "e"]) { instance.document.getText("content").insert(instance.document.getText("content").length, text); await instance.onSave(); }
      for (let i = 0; i < 8; i++) await instance.onAlarm();
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      const keys = [...(await state.storage.list()).keys()].filter(key => key.startsWith("text-v2:snapshot:manifest:") || key.startsWith("text-v2:snapshot:chunk:"));
      expect(new Set(keys.map(key => Number(key.match(/(?:manifest:|chunk:)(\d+)/)?.[1])))).toEqual(new Set([head.previous.generation, head.current.generation]));
    });
  });

  it("ACKs durably through a cleanup failure and retries cleanup on alarm", async () => {
    const value = await liveFile(); const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onLoad(); let ack = "";
      instance.broadcastCustomMessage = ((message: string) => { ack = message; }) as any;
      for (let i = 0; i < 3; i++) { instance.document.getText("content").insert(i, "x"); await instance.onSave(); }
      const original = instance.deleteSnapshotKeys.bind(instance); let failed = false;
      instance.deleteSnapshotKeys = async keys => { if (!failed) { failed = true; throw new Error("injected_delete_failure"); } await original(keys); };
      await instance.onAlarm();
      expect(JSON.parse(ack).snapshotGeneration).toBe(3);
      expect(await state.storage.get("text-v2:snapshot:cleanup")).toBeDefined();
      await instance.onAlarm();
      expect(await state.storage.get("text-v2:snapshot:cleanup")).toBeUndefined();
    });
    await evictDurableObject(stub);
    expect(await runInDurableObject(stub, async instance => { await instance.onLoad(); return instance.document.getText("content").toString(); })).toBe("xxx");
  });

  it("retains a pinned recovery generation until it is explicitly released", async () => {
    const value = await liveFile(); const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onLoad(); instance.document.getText("content").insert(0, "1"); await instance.onSave(); await instance.setGenerationPinned(1, true);
      for (const text of ["2", "3", "4"]) { instance.document.getText("content").insert(instance.document.getText("content").length, text); await instance.onSave(); }
      for (let i = 0; i < 5; i++) await instance.onAlarm();
      expect(await state.storage.get("text-v2:snapshot:manifest:1")).toBeDefined();
      await instance.setGenerationPinned(1, false); await instance.onAlarm();
      expect(await state.storage.get("text-v2:snapshot:manifest:1")).toBeUndefined();
    });
  });

  it("restores the cleanup backlog after a durable object restart", async () => {
    const value = await liveFile(); const stub = env.TextFileV2.getByName(value.room);
    await runInDurableObject(stub, async instance => { await instance.onLoad(); for (const text of ["1", "2", "3", "4"]) { instance.document.getText("content").insert(instance.document.getText("content").length, text); await instance.onSave(); } });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => instance.onAlarm());
    await runInDurableObject(stub, async (_instance, state) => expect((await state.storage.list({ prefix: "text-v2:snapshot:manifest:" })).size).toBe(2));
  });

  it("blocks client sync updates on read-only connections while allowing step1", async () => {
    const value = await liveFile("read");
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      const closed: Array<[number, string]> = [];
      const connection = { state: { grantId: "guest", permission: "read", windowAt: Date.now(), frames: 0, updates: 0, awareness: 0 }, setState(next: any) { this.state = next; }, close(code: number, reason: string) { closed.push([code, reason]); }, send() {} } as any;
      const step1 = encoding.createEncoder(); encoding.writeVarUint(step1, 0); syncProtocol.writeSyncStep1(step1, new Doc());
      await instance.onMessage(connection, encoding.toUint8Array(step1));
      expect(closed).toEqual([]);
      const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); syncProtocol.writeUpdate(update, new Uint8Array([0, 0]));
      await instance.onMessage(connection, encoding.toUint8Array(update));
      expect(closed).toEqual([[4403, "read_only_violation"]]);
    });
  });

  it("cannot bypass read-only mode with malformed sync or custom string messages", async () => {
    const value = await liveFile("read");
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      const malformed = testConnection("read"); await instance.onMessage(malformed.connection, new Uint8Array([0, 2, 255]));
      expect(malformed.closed[0]).toEqual([4403, "read_only_violation"]);
      const custom = testConnection("read"); await instance.onMessage(custom.connection, "{\"update\":true}");
      expect(custom.closed[0]).toEqual([4400, "custom_messages_disabled"]);
    });
  });

  it("fails closed before applying a mutating update when Coordinator authorization is unavailable", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      (instance as any).coordinatorEnv = { ProjectCoordinatorV2: { getByName: () => ({ authorizeTextMessage: async () => { throw new Error("unavailable"); } }) } };
      const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); syncProtocol.writeUpdate(update, new Uint8Array([0, 0]));
      const test = testConnection(); await instance.onMessage(test.connection, encoding.toUint8Array(update));
      expect(test.closed).toEqual([[4403, "authority_revoked"]]);
    });
  });

  it("serializes mutating frames across asynchronous authorization and preserves rate state", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
      (instance as any).coordinatorEnv = { ProjectCoordinatorV2: { getByName: () => ({ authorizeTextMessage: async () => { calls++; if (calls === 1) await gate; return true; } }) } };
      const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); syncProtocol.writeUpdate(update, new Uint8Array([0, 0])); const bytes = encoding.toUint8Array(update);
      const test = testConnection(); const first = instance.onMessage(test.connection, bytes); const second = instance.onMessage(test.connection, bytes);
      await Promise.resolve(); expect(calls).toBe(1); expect(test.connection.state.updates).toBe(0);
      release(); await Promise.all([first, second]); expect(calls).toBe(1); expect(test.connection.state.updates).toBe(2); expect(test.closed).toEqual([]);
      // The serialized second frame is still authorized, just served from the
      // cache that the first frame populated.
      test.connection.state.authorizedAt = Date.now() - AUTH_CACHE_MS - 1;
      await instance.onMessage(test.connection, bytes);
      expect(calls).toBe(2); expect(test.connection.state.updates).toBe(3);
    });
  });

  it("fences deletion durably and rejects reconnects and later saves", async () => {
    const value = await liveFile();
    const stub = env.TextFileV2.getByName(value.room);
    await value.coordinator.fetch(`https://test/v2/projects/${value.projectInstanceId}/delete-begin`, { method: "POST", headers: { Authorization: `Bearer ${hostSecret}` }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedCatalogRevision: 2, fileId: value.file.fileId }) });
    expect(await stub.fenceForDeletion(value.projectInstanceId, value.file.fileId, value.file.documentEpoch)).toBe(true);
    const freshTicket = await value.coordinator.consumeSocketTicket(value.ticket, "file", value.file.fileId, value.file.documentEpoch);
    expect(freshTicket).toBeNull();
    await evictDurableObject(stub);
    const response = await stub.fetch("https://room/", { headers: { Upgrade: "websocket", "x-lattice-project": value.projectInstanceId, "x-lattice-file": value.file.fileId, "x-lattice-epoch": String(value.file.documentEpoch), "x-lattice-permission": "host" } });
    expect(response.status).toBe(410);
    expect(await response.json<any>()).toMatchObject({ error: "file_deleted" });
  });

  it("clears File DO callback state when a successful fence callback is retried after restart", async () => {
    const value = await liveFile(); const stub = env.TextFileV2.getByName(value.room);
    await value.coordinator.fetch(`https://test/v2/projects/${value.projectInstanceId}/delete-begin`, { method: "POST", headers: { Authorization: `Bearer ${hostSecret}` }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedCatalogRevision: 2, fileId: value.file.fileId }) });
    expect(await stub.fenceForDeletion(value.projectInstanceId, value.file.fileId, 1)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => state.storage.put("text-v2:pending-coordinator", { kind: "deleted", identity: { protocol: 2, projectInstanceId: value.projectInstanceId, fileId: value.file.fileId, documentEpoch: 1, fenced: "deleted" } }));
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => instance.onAlarm());
    expect(await runInDurableObject(stub, async (_instance, state) => state.storage.get("text-v2:pending-coordinator"))).toBeUndefined();
  });

  it("closes oversized frames predictably without delegating them", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad(); let closed: [number, string] | undefined;
      await instance.onMessage({ state: { grantId: "host", permission: "host", windowAt: Date.now(), frames: 0, updates: 0, awareness: 0 }, close: (code: number, reason: string) => { closed = [code, reason]; } } as any, new Uint8Array(1024 * 1024 + 1));
      expect(closed).toEqual([1009, "frame_too_large"]);
    });
  });

  it("enforces malformed protocol, awareness, update, document, and rate limits", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      const cases: Array<[Uint8Array, Partial<any>, [number, string]]> = [
        [new Uint8Array(), {}, [4400, "invalid_protocol"]],
        [new Uint8Array(64 * 1024 + 1).fill(1), {}, [1009, "awareness_too_large"]],
        [new Uint8Array(512 * 1024 + 1).fill(2).map((v, i) => i < 2 ? (i === 0 ? 0 : 2) : v), {}, [1009, "update_too_large"]],
        [new Uint8Array([1]), { awareness: MAX_AWARENESS_PER_MINUTE }, [4429, "awareness_rate_limited"]],
        [new Uint8Array([0, 2]), { updates: MAX_UPDATES_PER_MINUTE }, [4429, "update_rate_limited"]],
        [new Uint8Array([1]), { frames: MAX_FRAMES_PER_MINUTE }, [4429, "frame_rate_limited"]],
      ];
      for (const [message, state, expected] of cases) { const test = testConnection(); Object.assign(test.connection.state, state); await instance.onMessage(test.connection, message); expect(test.closed[0]).toEqual(expected); }
      instance.document.getText("content").insert(0, "x".repeat(5 * 1024 * 1024));
      const document = testConnection(); await instance.onMessage(document.connection, new Uint8Array([0, 2]));
      expect(document.closed[0]).toEqual([1009, "document_too_large"]);
    });
  });

  it("caches a successful authorization and re-checks only after the cache window", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); syncProtocol.writeUpdate(update, new Uint8Array([0, 0])); const bytes = encoding.toUint8Array(update);
      let calls = 0;
      (instance as any).coordinatorEnv = { ProjectCoordinatorV2: { getByName: () => ({ authorizeTextMessage: async () => { calls++; return true; } }) } };
      const test = testConnection();
      await instance.onMessage(test.connection, bytes);
      await instance.onMessage(test.connection, bytes);
      expect(calls).toBe(1); expect(test.closed).toEqual([]);
      test.connection.state.authorizedAt = Date.now() - AUTH_CACHE_MS - 1;
      await instance.onMessage(test.connection, bytes);
      expect(calls).toBe(2); expect(test.closed).toEqual([]);
    });
  });

  it("tolerates a coordinator outage only within the leeway of a fresh authorization", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); syncProtocol.writeUpdate(update, new Uint8Array([0, 0])); const bytes = encoding.toUint8Array(update);
      (instance as any).coordinatorEnv = { ProjectCoordinatorV2: { getByName: () => ({ authorizeTextMessage: async () => { throw new Error("unavailable"); } }) } };
      const fresh = testConnection(); fresh.connection.state.authorizedAt = Date.now();
      await instance.onMessage(fresh.connection, bytes);
      expect(fresh.closed).toEqual([]);
      const stale = testConnection(); stale.connection.state.authorizedAt = Date.now() - AUTH_OUTAGE_LEEWAY_MS - 1;
      await instance.onMessage(stale.connection, bytes);
      expect(stale.closed).toEqual([[4403, "authority_revoked"]]);
    });
  });

  it("closes on a definitive denial even inside the outage leeway", async () => {
    const value = await liveFile();
    await runInDurableObject(env.TextFileV2.getByName(value.room), async (instance) => {
      await instance.onLoad();
      const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); syncProtocol.writeUpdate(update, new Uint8Array([0, 0])); const bytes = encoding.toUint8Array(update);
      (instance as any).coordinatorEnv = { ProjectCoordinatorV2: { getByName: () => ({ authorizeTextMessage: async () => false }) } };
      // Cache expired but the outage leeway would still cover this state; a
      // definitive denial must not be laundered through the leeway.
      const test = testConnection(); test.connection.state.authorizedAt = Date.now() - AUTH_CACHE_MS - 1;
      await instance.onMessage(test.connection, bytes);
      expect(test.closed).toEqual([[4403, "authority_revoked"]]);
    });
  });
});
