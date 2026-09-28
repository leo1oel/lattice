import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Doc } from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { parseTextFileV2RoomName, textFileV2RoomName } from "../../protocol/collab-v2";
import { sha256Hex } from "../../protocol/encoding";
import { AUTH_CACHE_MS, AUTH_OUTAGE_LEEWAY_MS, MAX_AWARENESS_PER_MINUTE, MAX_FRAMES_PER_MINUTE, MAX_UPDATES_PER_MINUTE, type TextFileV2 } from "../src/text-file-v2";
import { createProject, HOST_SECRET, storedValue, upgradeHeaders } from "./harness";

/** A live `paper.md` in a fresh project, with its room and an unused host socket ticket. */
async function liveFile() {
  const project = await createProject("text-v2", { direct: true, paths: ["paper.md"], ready: true });
  const roomName = textFileV2RoomName(project.id, project.fileId, 1);
  const { ticket } = (await project.call("tickets", { body: { audience: "file", fileId: project.fileId } })).body;
  return { ...project, coordinator: project.stub, roomName, room: env.TextFileV2.getByName(roomName), ticket: ticket as string };
}

/** Runs `test` inside the loaded room of a fresh live file. */
async function inLoadedRoom(test: (instance: TextFileV2, state: DurableObjectState) => Promise<void>) {
  const file = await liveFile();
  await runInDurableObject(file.room, async (instance, state) => { await instance.onLoad(); await test(instance, state); });
  return file;
}

const roomText = (room: DurableObjectStub<TextFileV2>) => runInDurableObject(room, async (instance) => { await instance.onLoad(); return instance.document.getText("content").toString(); });

/** Appends each text in turn, saving a snapshot generation after each. */
async function saveEach(instance: TextFileV2, texts: string[]) {
  for (const text of texts) {
    const content = instance.document.getText("content");
    content.insert(content.length, text);
    await instance.onSave();
  }
}

function syncFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  write(encoder);
  return encoding.toUint8Array(encoder);
}
const updateFrame = () => syncFrame((encoder) => syncProtocol.writeUpdate(encoder, new Uint8Array([0, 0])));

function useAuthorizer(instance: TextFileV2, authorizeTextMessage: () => Promise<boolean>) {
  (instance as any).coordinatorEnv = { ProjectCoordinatorV2: { getByName: () => ({ authorizeTextMessage }) } };
}

function testConnection(permission: "host" | "read" = "host") {
  const closed: Array<[number, string]> = [];
  const connection = { state: { grantId: "host", permission, grantEpoch: 1, projectAuthorityEpoch: 1, windowAt: Date.now(), frames: 0, updates: 0, awareness: 0 }, setState(next: any) { this.state = next; }, close(code: number, reason: string) { closed.push([code, reason]); }, send() {} } as any;
  return { connection, closed };
}

async function deleteRoomContent(file: Awaited<ReturnType<typeof liveFile>>) {
  await file.mutate("delete-begin", 2, { fileId: file.fileId });
  expect(await file.room.fenceForDeletion(file.id, file.fileId, 1)).toBe(true);
}

describe("TextFileV2 data plane", () => {
  it("uses a canonical, validated identity room", () => {
    const room = textFileV2RoomName("project-abcdefghijkl", "file-id-abcdefghijkl", 7);
    expect(parseTextFileV2RoomName(room)).toMatchObject({ projectInstanceId: "project-abcdefghijkl", fileId: "file-id-abcdefghijkl", documentEpoch: 7 });
    expect(parseTextFileV2RoomName(`${room}x`)).toBeNull();
  });

  it("gates upgrade with an exact one-use ticket", async () => {
    const { roomName, ticket } = await liveFile();
    const upgrade = (query = "") => SELF.fetch(`https://test/parties/text-file-v2/${roomName}${query}`, { headers: { Upgrade: "websocket" } });
    expect((await upgrade()).status).toBe(401);
    expect((await upgrade(`?ticket=${encodeURIComponent(ticket)}`)).status).toBe(101);
    expect((await upgrade(`?ticket=${encodeURIComponent(ticket)}`)).status).toBe(403);
  });

  it("durably initializes a live-project text file before publishing it", async () => {
    const { id, call, mutate } = await createProject("text-seed", { direct: true });
    const bytes = new TextEncoder().encode("# Durable first\n");
    const hash = await sha256Hex(bytes);
    const operationId = "initialize_durable_first";
    const file = (await mutate("create", 1, { path: "new.md", kind: "text", initializer: { operationId, size: bytes.byteLength, hash } })).body.value;
    expect((await call("catalog")).body.files[0].state).toBe("initializing");
    const upload = () => SELF.fetch(`https://test/v2/projects/${id}/text/imports/${file.fileId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${HOST_SECRET}`, "content-length": String(bytes.byteLength), "x-document-epoch": "1", "x-content-sha256": hash, "x-operation-id": operationId },
      body: bytes,
    });
    expect((await upload()).status).toBe(201);
    expect((await call("catalog")).body.files[0]).toMatchObject({ state: "live", size: bytes.byteLength, hash });
    expect(await roomText(env.TextFileV2.getByName(textFileV2RoomName(id, file.fileId, 1)))).toBe("# Durable first\n");
    expect((await upload()).status).toBe(200);
  });

  it("persists immutable generations, caches metadata, and recovers the previous generation", async () => {
    const { room, call } = await inLoadedRoom(async (instance, state) => {
      await saveEach(instance, ["old", " new"]);
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      await state.storage.delete(`text-v2:snapshot:chunk:${head.current.generation}:0`);
    });
    await evictDurableObject(room);
    expect(await roomText(room)).toBe("old");
    expect((await call("catalog")).body.files[0]).toMatchObject({ contentRevision: 2, hash: expect.any(String), size: expect.any(Number) });
  });

  it("fails closed when current and previous generations are corrupt", async () => {
    const { room } = await inLoadedRoom(async (instance, state) => {
      await saveEach(instance, ["one", " two"]);
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      await state.storage.delete(`text-v2:snapshot:chunk:${head.current.generation}:0`);
      await state.storage.delete(`text-v2:snapshot:chunk:${head.previous.generation}:0`);
    });
    await evictDurableObject(room);
    await expect(runInDurableObject(room, (instance) => instance.onLoad())).rejects.toThrow("corrupt_snapshot");
  });

  it.each([
    ["generation", 0], ["contentRevision", -1], ["chunkCount", 0], ["byteLength", 0],
    ["sha256", "nope"], ["documentEpoch", 0],
  ])("rejects a manifest with invalid %s", async (field, invalid) => {
    const { room } = await inLoadedRoom(async (instance, state) => {
      await saveEach(instance, ["valid"]);
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      const key = `text-v2:snapshot:manifest:${head.current.generation}`;
      await state.storage.put(key, { ...await state.storage.get<any>(key), [field]: invalid });
    });
    await evictDurableObject(room);
    await expect(runInDurableObject(room, (instance) => instance.onLoad())).rejects.toThrow("corrupt_snapshot");
  });

  it("publishes the pointer before emitting the exact durable custom ACK", async () => {
    let payload = "";
    const { id, fileId } = await inLoadedRoom(async (instance, state) => {
      instance.document.getText("content").insert(0, "ack");
      let pointerPublished = false;
      const originalPut = state.storage.put.bind(state.storage);
      state.storage.put = (async (key: any, stored: any, options?: any) => {
        if (key === "text-v2:snapshot:head") pointerPublished = true;
        return originalPut(key, stored, options);
      }) as any;
      instance.broadcastCustomMessage = ((message: string) => { expect(pointerPublished).toBe(true); payload = message; }) as any;
      await instance.onSave();
    });
    expect(JSON.parse(payload)).toEqual({ type: "lattice.durable-ack", protocol: 2, projectInstanceId: id, fileId, documentEpoch: 1, contentRevision: 1, snapshotGeneration: 1, stateVector: expect.any(String), size: expect.any(Number), hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("keeps only the complete current and previous generations after repeated saves", async () => {
    await inLoadedRoom(async (instance, state) => {
      await saveEach(instance, ["a", "b", "c", "d", "e"]);
      for (let i = 0; i < 8; i++) await instance.onAlarm();
      const head = await state.storage.get<any>("text-v2:snapshot:head");
      const keys = [...(await state.storage.list()).keys()].filter((key) => key.startsWith("text-v2:snapshot:manifest:") || key.startsWith("text-v2:snapshot:chunk:"));
      expect(new Set(keys.map((key) => Number(key.match(/(?:manifest:|chunk:)(\d+)/)?.[1])))).toEqual(new Set([head.previous.generation, head.current.generation]));
    });
  });

  it("ACKs durably through a cleanup failure and retries cleanup on alarm", async () => {
    const { room } = await inLoadedRoom(async (instance, state) => {
      let ack = "";
      instance.broadcastCustomMessage = ((message: string) => { ack = message; }) as any;
      await saveEach(instance, ["x", "x", "x"]);
      const original = instance.deleteSnapshotKeys.bind(instance);
      let failed = false;
      instance.deleteSnapshotKeys = async (keys) => { if (!failed) { failed = true; throw new Error("injected_delete_failure"); } await original(keys); };
      await instance.onAlarm();
      expect(JSON.parse(ack).snapshotGeneration).toBe(3);
      expect(await state.storage.get("text-v2:snapshot:cleanup")).toBeDefined();
      await instance.onAlarm();
      expect(await state.storage.get("text-v2:snapshot:cleanup")).toBeUndefined();
    });
    await evictDurableObject(room);
    expect(await roomText(room)).toBe("xxx");
  });

  it("retains a pinned recovery generation until it is explicitly released", async () => {
    await inLoadedRoom(async (instance, state) => {
      await saveEach(instance, ["1"]);
      await instance.setGenerationPinned(1, true);
      await saveEach(instance, ["2", "3", "4"]);
      for (let i = 0; i < 5; i++) await instance.onAlarm();
      expect(await state.storage.get("text-v2:snapshot:manifest:1")).toBeDefined();
      await instance.setGenerationPinned(1, false);
      await instance.onAlarm();
      expect(await state.storage.get("text-v2:snapshot:manifest:1")).toBeUndefined();
    });
  });

  it("restores the cleanup backlog after a durable object restart", async () => {
    const { room } = await inLoadedRoom((instance) => saveEach(instance, ["1", "2", "3", "4"]));
    await evictDurableObject(room);
    await runInDurableObject(room, (instance) => instance.onAlarm());
    await runInDurableObject(room, async (_instance, state) => expect((await state.storage.list({ prefix: "text-v2:snapshot:manifest:" })).size).toBe(2));
  });

  it.each([
    ["allows sync step 1", syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, new Doc())), []],
    ["blocks a sync update", updateFrame(), [[4403, "read_only_violation"]]],
    ["blocks a malformed sync frame", new Uint8Array([0, 2, 255]), [[4403, "read_only_violation"]]],
    ["blocks custom string messages", "{\"update\":true}", [[4400, "custom_messages_disabled"]]],
  ] as const)("on a read-only connection %s", async (_case, message, expected) => {
    await inLoadedRoom(async (instance) => {
      const { connection, closed } = testConnection("read");
      await instance.onMessage(connection, message as Uint8Array | string);
      expect(closed).toEqual(expected);
    });
  });

  it.each([
    ["fails closed when the coordinator is unreachable and nothing was authorized", "unreachable", undefined, [[4403, "authority_revoked"]]],
    ["serves a fresh authorization through a coordinator outage", "unreachable", 0, []],
    ["fails closed on an outage once the last authorization is past the leeway", "unreachable", AUTH_OUTAGE_LEEWAY_MS + 1, [[4403, "authority_revoked"]]],
    // The cache has expired but the outage leeway would still cover this state;
    // a definitive denial must not be laundered through the leeway.
    ["closes on a definitive denial even inside the outage leeway", "denies", AUTH_CACHE_MS + 1, [[4403, "authority_revoked"]]],
  ] as const)("%s", async (_title, coordinator, authorizedAgo, expected) => {
    await inLoadedRoom(async (instance) => {
      useAuthorizer(instance, async () => { if (coordinator === "unreachable") throw new Error("unavailable"); return false; });
      const test = testConnection();
      if (authorizedAgo !== undefined) test.connection.state.authorizedAt = Date.now() - authorizedAgo;
      await instance.onMessage(test.connection, updateFrame());
      expect(test.closed).toEqual(expected);
    });
  });

  it("serializes mutating frames across asynchronous authorization and preserves rate state", async () => {
    await inLoadedRoom(async (instance) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      useAuthorizer(instance, async () => { calls++; if (calls === 1) await gate; return true; });
      const test = testConnection();
      const bytes = updateFrame();
      const first = instance.onMessage(test.connection, bytes);
      const second = instance.onMessage(test.connection, bytes);
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(test.connection.state.updates).toBe(0);
      release();
      await Promise.all([first, second]);
      // The serialized second frame is still authorized, just served from the
      // cache that the first frame populated.
      expect(calls).toBe(1);
      expect(test.connection.state.updates).toBe(2);
      expect(test.closed).toEqual([]);
      test.connection.state.authorizedAt = Date.now() - AUTH_CACHE_MS - 1;
      await instance.onMessage(test.connection, bytes);
      expect(calls).toBe(2);
      expect(test.connection.state.updates).toBe(3);
    });
  });

  it("caches a successful authorization and re-checks only after the cache window", async () => {
    await inLoadedRoom(async (instance) => {
      let calls = 0;
      useAuthorizer(instance, async () => { calls++; return true; });
      const test = testConnection();
      await instance.onMessage(test.connection, updateFrame());
      await instance.onMessage(test.connection, updateFrame());
      expect(calls).toBe(1);
      test.connection.state.authorizedAt = Date.now() - AUTH_CACHE_MS - 1;
      await instance.onMessage(test.connection, updateFrame());
      expect(calls).toBe(2);
      expect(test.closed).toEqual([]);
    });
  });

  it("fences deletion durably and rejects reconnects and later saves", async () => {
    const file = await liveFile();
    await deleteRoomContent(file);
    expect(await file.coordinator.consumeSocketTicket(file.ticket, "file", file.fileId, 1)).toBeNull();
    await evictDurableObject(file.room);
    const response = await file.room.fetch("https://room/", { headers: upgradeHeaders(file.id, file.fileId) });
    expect(response.status).toBe(410);
    expect(await response.json<any>()).toMatchObject({ error: "file_deleted" });
  });

  it("clears File DO callback state when a successful fence callback is retried after restart", async () => {
    const file = await liveFile();
    await deleteRoomContent(file);
    await runInDurableObject(file.room, async (_instance, state) => state.storage.put("text-v2:pending-coordinator", { kind: "deleted", identity: { protocol: 2, projectInstanceId: file.id, fileId: file.fileId, documentEpoch: 1, fenced: "deleted" } }));
    await evictDurableObject(file.room);
    await runInDurableObject(file.room, (instance) => instance.onAlarm());
    expect(await storedValue(file.room, "text-v2:pending-coordinator")).toBeUndefined();
  });

  it("enforces frame size, malformed protocol, awareness, update, document, and rate limits", async () => {
    await inLoadedRoom(async (instance) => {
      const cases: Array<[Uint8Array, Partial<any>, [number, string]]> = [
        [new Uint8Array(1024 * 1024 + 1), {}, [1009, "frame_too_large"]],
        [new Uint8Array(), {}, [4400, "invalid_protocol"]],
        [new Uint8Array(64 * 1024 + 1).fill(1), {}, [1009, "awareness_too_large"]],
        [new Uint8Array(512 * 1024 + 1).fill(2).map((v, i) => i < 2 ? (i === 0 ? 0 : 2) : v), {}, [1009, "update_too_large"]],
        [new Uint8Array([1]), { awareness: MAX_AWARENESS_PER_MINUTE }, [4429, "awareness_rate_limited"]],
        [new Uint8Array([0, 2]), { updates: MAX_UPDATES_PER_MINUTE }, [4429, "update_rate_limited"]],
        [new Uint8Array([1]), { frames: MAX_FRAMES_PER_MINUTE }, [4429, "frame_rate_limited"]],
      ];
      for (const [message, state, expected] of cases) {
        const test = testConnection();
        Object.assign(test.connection.state, state);
        await instance.onMessage(test.connection, message);
        expect(test.closed[0]).toEqual(expected);
      }
      instance.document.getText("content").insert(0, "x".repeat(5 * 1024 * 1024));
      const document = testConnection();
      await instance.onMessage(document.connection, new Uint8Array([0, 2]));
      expect(document.closed[0]).toEqual([1009, "document_too_large"]);
    });
  });
});
