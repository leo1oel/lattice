import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DurableAckV2 } from "../../protocol/collab-v2";
import { CollabTextDurableStoreV2, CollabTextStoreCorruptionErrorV2, textNamespaceKey, updateCoveredByStateVector, type TextNamespaceV2 } from "./collab-text-v2-store";
import { closeEventErrorV2, CollabTextClientV2, CollabTextProviderPoolV2, reconnectDelayV2, TextClientPermanentErrorV2, ticketHttpErrorV2, type ReconnectPolicyV2, type TextTransportV2 , isClientDestroyedErrorV2 } from "./collab-text-v2";

const namespace: TextNamespaceV2 = { deployment: "sync.example", projectInstanceId: "project", fileId: "file", documentEpoch: 1 };
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
class Transport implements TextTransportV2 {
  sent: Uint8Array[] = []; custom?: (value: unknown) => void; disconnected?: (error?: unknown) => void; synced?: (value: boolean) => void;
  clearAwareness = vi.fn(); destroy = vi.fn();
  constructor(readonly networkDoc: Y.Doc) { networkDoc.on("update", (update, origin) => { if (origin !== "server") this.sent.push(update); }); }
  remote(update: Uint8Array) { Y.applyUpdate(this.networkDoc, update, "server"); }
  onCustomMessage(listener: (value: unknown) => void) { this.custom = listener; return () => undefined; }
  onDisconnect(listener: (error?: unknown) => void) { this.disconnected = listener; return () => { if (this.disconnected === listener) this.disconnected = undefined; }; }
  onSynced(listener: (synced: boolean) => void) { this.synced = listener; return () => { if (this.synced === listener) this.synced = undefined; }; }
}
function ack(doc: Y.Doc, patch: Partial<DurableAckV2> = {}): DurableAckV2 { return { type: "lattice.durable-ack", protocol: 2, projectInstanceId: "project", fileId: "file", documentEpoch: 1, contentRevision: 1, snapshotGeneration: 1, stateVector: b64(Y.encodeStateVector(doc)), size: 1, hash: "0".repeat(64), ...patch }; }
async function setup(idb = new IDBFactory(), identity = namespace) { const transports: Transport[] = []; const tickets: string[] = []; const store = new CollabTextDurableStoreV2(idb); const client = await CollabTextClientV2.open(identity, { store, issueTicket: async () => { const ticket = `ticket-${tickets.length + 1}`; tickets.push(ticket); return ticket; }, transportFactory: ({ doc }) => { const transport = new Transport(doc); transports.push(transport); return transport; } }); return { client, store, transports, tickets, idb }; }

describe("v2 durable text client", () => {
  it("caps jittered reconnect delays at 2.5 seconds", () => {
    expect(reconnectDelayV2(0, () => 0)).toBe(75);
    expect(reconnectDelayV2(0, () => 1)).toBe(125);
    expect(reconnectDelayV2(20, () => 1)).toBe(2_500);
  });

  it("reuses a healthy or in-flight connection instead of replacing its transport", async () => {
    let releaseTicket!: () => void;
    const ticketGate = new Promise<void>((resolve) => { releaseTicket = resolve; });
    const transports: Transport[] = [];
    const tickets = vi.fn(async () => { await ticketGate; return "ticket"; });
    const client = await CollabTextClientV2.open(namespace, {
      store: new CollabTextDurableStoreV2(new IDBFactory()),
      issueTicket: tickets,
      transportFactory: ({ doc }) => {
        const transport = new Transport(doc);
        transports.push(transport);
        return transport;
      },
    });

    const first = client.connect();
    const concurrent = client.connect();
    releaseTicket();
    await Promise.all([first, concurrent]);
    await client.connect();

    expect(tickets).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.destroy).not.toHaveBeenCalled();
    client.destroy();
  });

  it("rejects an in-flight connection when the client is destroyed before its ticket arrives", async () => {
    let releaseTicket!: () => void;
    const ticketGate = new Promise<void>((resolve) => { releaseTicket = resolve; });
    const transports: Transport[] = [];
    const client = await CollabTextClientV2.open(namespace, {
      store: new CollabTextDurableStoreV2(new IDBFactory()),
      issueTicket: async () => { await ticketGate; return "late-ticket"; },
      transportFactory: ({ doc }) => { const transport = new Transport(doc); transports.push(transport); return transport; },
    });
    const connecting = client.connect();
    client.destroy();
    releaseTicket();
    await expect(connecting).rejects.toThrow("Client is destroyed");
    // Typed, so callers can tell an ordinary teardown apart from a failure
    // instead of matching on the message.
    await expect(connecting).rejects.toSatisfy(isClientDestroyedErrorV2);
    expect(transports).toHaveLength(0);
  });

  it("persists locally before send and restores/replays after reload", async () => {
    const x = await setup(); await x.client.connect(); x.client.doc.getText("content").insert(0, "safe"); await x.client.settled();
    expect((await x.store.load(namespace))?.outbox).toHaveLength(1); expect(x.transports[0].sent).toHaveLength(1);
    const y = await setup(x.idb); expect(y.client.doc.getText("content").toString()).toBe("safe"); await y.client.connect(); expect(y.transports[0].sent).toHaveLength(1);
  });
  it("fails closed and preserves the raw recovery record when IndexedDB data is corrupt", async () => {
    const corrupt = { key: textNamespaceKey(namespace), namespace, snapshot: new Uint8Array([255]), outbox: [{ id: "draft", update: new Uint8Array([255]), createdAt: 1 }] };
    class CorruptStore extends CollabTextDurableStoreV2 { protected override async read() { return corrupt; } }
    await expect(CollabTextClientV2.open(namespace, { store: new CorruptStore(new IDBFactory()), issueTicket: async () => "ticket", transportFactory: ({ doc }) => new Transport(doc) }))
      .rejects.toEqual(expect.objectContaining<Partial<CollabTextStoreCorruptionErrorV2>>({ record: corrupt, issues: ["invalid_snapshot", "invalid_outbox_update"] }));
  });
  it("does not publish a local update until the durable store resolves", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    class GatedStore extends CollabTextDurableStoreV2 { override async persistLocal(...args: Parameters<CollabTextDurableStoreV2["persistLocal"]>) { await gate; return super.persistLocal(...args); } }
    const transports: Transport[] = []; const client = await CollabTextClientV2.open(namespace, { store: new GatedStore(new IDBFactory()), issueTicket: async () => "ticket", transportFactory: ({ doc }) => { const t = new Transport(doc); transports.push(t); return t; } }); await client.connect(); client.doc.getText("x").insert(0, "durable-first"); await Promise.resolve(); expect(transports[0].sent).toHaveLength(0); release(); await client.settled(); expect(transports[0].sent).toHaveLength(1);
  });
  it("recovers idempotently when ACK recording succeeds but covered deletion crashes", async () => {
    class CrashDeleteStore extends CollabTextDurableStoreV2 { fail = true; override async compactAck(namespace: TextNamespaceV2, snapshot: Uint8Array, value: DurableAckV2, vector: Uint8Array) { if (this.fail) { this.fail = false; await this.recordAck(namespace, value); throw new Error("crash-after-ack"); } return super.compactAck(namespace, snapshot, value, vector); } }
    const idb = new IDBFactory(); const store = new CrashDeleteStore(idb); const transports: Transport[] = []; const client = await CollabTextClientV2.open(namespace, { store, issueTicket: async () => "ticket", transportFactory: ({ doc }) => { const t = new Transport(doc); transports.push(t); return t; } }); await client.connect(); client.doc.getText("x").insert(0, "a"); await client.settled(); transports[0].custom?.(ack(client.doc)); await expect(client.settled()).rejects.toThrow("crash-after-ack");
    const reopened = await setup(idb); expect(reopened.client.hasOutbox).toBe(false); expect(reopened.client.durabilityState).toBe("clean");
  });
  it("checkpoints successive acknowledged updates before removing them from the outbox", async () => {
    const x = await setup(); await x.client.connect();
    x.client.doc.getText("content").insert(0, "first"); await x.client.settled();
    x.client.doc.getText("content").insert(5, " second"); await x.client.settled();
    x.transports[0].custom?.(ack(x.client.doc)); await x.client.settled();
    const reopened = await setup(x.idb);
    expect(reopened.client.doc.getText("content").toString()).toBe("first second");
    expect(reopened.client.hasOutbox).toBe(false);
    expect((await reopened.store.load(namespace))?.outbox).toHaveLength(0);
  });
  it("captures an ACK checkpoint before a later queued local update", async () => {
    const x = await setup(); await x.client.connect();
    x.client.doc.getText("content").insert(0, "first"); await x.client.settled();
    x.transports[0].custom?.(ack(x.client.doc));
    x.client.doc.getText("content").insert(5, " second");
    await x.client.settled();

    const saved = await x.store.export(namespace);
    const checkpoint = new Y.Doc();
    Y.applyUpdate(checkpoint, saved!.snapshot);
    expect(checkpoint.getText("content").toString()).toBe("first");
    expect(saved!.outbox).toHaveLength(1);
    const reopened = await setup(x.idb);
    expect(reopened.client.doc.getText("content").toString()).toBe("first second");
    expect(reopened.client.hasOutbox).toBe(true);
  });
  it("only a matching monotonic durable ACK with Yjs vector coverage clears updates", async () => {
    const x = await setup(); await x.client.connect(); x.client.doc.getText("content").insert(0, "a"); await x.client.settled();
    x.transports[0].custom?.(ack(x.client.doc, { fileId: "wrong" })); await Promise.resolve(); expect(x.client.hasOutbox).toBe(true);
    x.transports[0].custom?.(ack(x.client.doc)); await vi.waitFor(() => expect(x.client.hasOutbox).toBe(false));
    x.client.doc.getText("content").insert(1, "b"); await x.client.settled(); x.transports[0].custom?.(ack(x.client.doc, { contentRevision: 0, snapshotGeneration: 0 })); await Promise.resolve(); expect(x.client.hasOutbox).toBe(true);
  });
  it("proves coverage for concurrent and merged real Yjs updates", () => {
    const a = new Y.Doc(); const b = new Y.Doc(); a.getText("x").insert(0, "a"); b.getText("x").insert(0, "b"); const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b); const merged = Y.mergeUpdates([ua, ub]); const server = new Y.Doc(); Y.applyUpdate(server, merged);
    expect(updateCoveredByStateVector(ua, Y.encodeStateVector(server))).toBe(true); expect(updateCoveredByStateVector(ub, Y.encodeStateVector(a))).toBe(false); expect(updateCoveredByStateVector(merged, Y.encodeStateVector(server))).toBe(true);
  });
  it("uses the end clock for an incremental update with preceding history", () => {
    const source = new Y.Doc(); source.getText("x").insert(0, "prefix"); const before = Y.encodeStateVector(source); source.getText("x").insert(6, "tail"); const incremental = Y.encodeStateAsUpdate(source, before);
    expect(updateCoveredByStateVector(incremental, before)).toBe(false); expect(updateCoveredByStateVector(incremental, Y.encodeStateVector(source))).toBe(true);
  });
  it("does not echo remote Yjs updates and persists their snapshot", async () => {
    const x = await setup(); await x.client.connect(); const remote = new Y.Doc(); remote.getText("content").insert(0, "remote");
    x.transports[0].remote(Y.encodeStateAsUpdate(remote)); await x.client.settled();
    expect(x.client.doc.getText("content").toString()).toBe("remote"); expect(x.transports[0].sent).toHaveLength(0); expect((await x.store.load(namespace))?.outbox).toHaveLength(0);
  });
  it("reports temporary, transport-synced, server-durable, and clean only from proven events", async () => {
    const x = await setup(); expect(x.client.durabilityState).toBe("temporary"); await x.client.connect(); expect(x.client.durabilityState).toBe("temporary");
    x.client.doc.getText("x").insert(0, "a"); await x.client.settled(); expect(x.client.durabilityState).toBe("temporary"); x.transports[0].synced?.(true); expect(x.client.durabilityState).toBe("transport-synced");
    x.client.doc.getText("x").insert(1, "b"); await x.client.settled(); const partial = new Y.Doc(); Y.applyUpdate(partial, x.transports[0].sent[0]); x.transports[0].custom?.(ack(partial)); await vi.waitFor(() => expect(x.client.durabilityState).toBe("server-durable"));
    x.transports[0].custom?.(ack(x.client.doc, { contentRevision: 2, snapshotGeneration: 2 })); await vi.waitFor(() => expect(x.client.durabilityState).toBe("clean"));
  });
  it("retries ordinary ticket failures with fresh tickets, but stops on permanent ticket failure", async () => {
    const tasks: (() => void)[] = []; const delays: number[] = []; const reconnect: ReconnectPolicyV2 = { schedule: (task, delay) => (delays.push(delay), tasks.push(task), task), cancel: (task) => { const i = tasks.indexOf(task as () => void); if (i >= 0) tasks.splice(i, 1); }, delay: (attempt) => 10 * (attempt + 1) };
    const store = new CollabTextDurableStoreV2(new IDBFactory()); let calls = 0; const client = await CollabTextClientV2.open(namespace, { store, reconnect, issueTicket: async () => { if (++calls === 1) throw new Error("offline"); return `fresh-${calls}`; }, transportFactory: ({ doc }) => new Transport(doc) });
    await expect(client.connect()).rejects.toThrow("offline"); expect(client.isStopped).toBe(false); expect(delays).toEqual([10]); tasks.shift()?.(); await vi.waitFor(() => expect(calls).toBe(2));
    const permanent = await CollabTextClientV2.open({ ...namespace, fileId: "other" }, { store, reconnect, issueTicket: async () => { throw new TextClientPermanentErrorV2("revoked"); }, transportFactory: ({ doc }) => new Transport(doc) });
    await expect(permanent.connect()).rejects.toMatchObject({ code: "revoked" }); expect(permanent.isStopped).toBe(true);
  });
  it("keeps increasing reconnect backoff until a transport actually syncs", async () => {
    const tasks: (() => void)[] = [];
    const delays: number[] = [];
    const reconnect: ReconnectPolicyV2 = {
      schedule: (task, delay) => (tasks.push(task), delays.push(delay), task),
      cancel: (task) => { const index = tasks.indexOf(task as () => void); if (index >= 0) tasks.splice(index, 1); },
      delay: (attempt) => 10 * (attempt + 1),
    };
    const transports: Transport[] = [];
    const client = await CollabTextClientV2.open(namespace, {
      store: new CollabTextDurableStoreV2(new IDBFactory()),
      reconnect,
      issueTicket: async () => "ticket",
      transportFactory: ({ doc }) => { const transport = new Transport(doc); transports.push(transport); return transport; },
    });

    await client.connect();
    transports[0]!.disconnected?.();
    tasks.shift()?.();
    await vi.waitFor(() => expect(transports).toHaveLength(2));
    transports[1]!.disconnected?.();
    tasks.shift()?.();
    await vi.waitFor(() => expect(transports).toHaveLength(3));
    transports[2]!.synced?.(true);
    transports[2]!.disconnected?.();

    expect(delays).toEqual([10, 20, 10]);
    client.destroy();
  });
  it("cancels stale reconnect callbacks on manual connect and destroy", async () => {
    const tasks: (() => void)[] = []; const reconnect: ReconnectPolicyV2 = { schedule: (task) => (tasks.push(task), task), cancel: () => undefined, delay: () => 1 }; const x = await setup();
    const client = await CollabTextClientV2.open(namespace, { store: x.store, reconnect, issueTicket: async () => "ticket", transportFactory: ({ doc }) => new Transport(doc) }); await client.connect(); const transport = new Transport(new Y.Doc());
    // Exercise generation checks even if a scheduler invokes an already-cancelled callback.
    (client as unknown as { onDisconnect(g: number): void }).onDisconnect(1); const stale = tasks[0]; await client.connect(); stale(); await Promise.resolve(); client.destroy(); stale(); expect(client.isStopped).toBe(false); transport.destroy();
  });
  it("maps permanent and transient WebSocket closes without treating CloseEvent as Error", () => {
    expect(closeEventErrorV2({ code: 1006 })).toBeInstanceOf(Error); expect(closeEventErrorV2({ code: 1006 })).not.toBeInstanceOf(TextClientPermanentErrorV2);
    expect(closeEventErrorV2({ code: 4403, reason: "revoked" })).toMatchObject({ code: "revoked" }); expect(closeEventErrorV2({ code: 4410 })).toMatchObject({ code: "file_deleted" }); expect(closeEventErrorV2({ code: 4411 })).toMatchObject({ code: "project_closed" }); expect(closeEventErrorV2({ code: 1000 })).toBeUndefined();
    expect(ticketHttpErrorV2(409)).toMatchObject({ code: "stale_epoch" }); expect(ticketHttpErrorV2(410, "tombstoned")).toMatchObject({ code: "file_deleted" }); expect(ticketHttpErrorV2(503)).not.toBeInstanceOf(TextClientPermanentErrorV2);
  });
  it("ignores malformed vectors and wrong project, file, epoch, duplicate, equal, and out-of-order ACKs", async () => {
    const x = await setup(); await x.client.connect(); x.client.doc.getText("x").insert(0, "a"); await x.client.settled();
    for (const bad of [{ projectInstanceId: "wrong" }, { fileId: "wrong" }, { documentEpoch: 2 }, { stateVector: "AAAA" }]) { x.transports[0].custom?.(ack(x.client.doc, bad)); await x.client.settled(); expect(x.client.hasOutbox).toBe(true); }
    x.transports[0].custom?.(ack(x.client.doc)); await vi.waitFor(() => expect(x.client.hasOutbox).toBe(false)); x.transports[0].custom?.(ack(x.client.doc)); x.transports[0].custom?.(ack(x.client.doc, { contentRevision: 0, snapshotGeneration: 0 })); await x.client.settled(); expect(x.client.durabilityState).toBe("clean");
  });
  it("recreates transport with a fresh ticket and stops permanently while retaining export", async () => {
    const x = await setup(); await x.client.connect(); x.client.doc.getText("x").insert(0, "offline"); await x.client.settled(); x.transports[0].disconnected?.(); await vi.waitFor(() => expect(x.tickets).toHaveLength(2));
    x.transports[1].disconnected?.(new TextClientPermanentErrorV2("file_deleted")); await vi.waitFor(() => expect(x.client.isStopped).toBe(true)); expect((await x.client.exportRecovery())?.outbox).toHaveLength(1);
  });
  it("notifies subscribers when the server permanently closes the project", async () => {
    const x = await setup();
    const errors: TextClientPermanentErrorV2[] = [];
    const unsubscribe = x.client.subscribePermanentError((error) => errors.push(error));
    await x.client.connect();
    x.transports[0].disconnected?.(new TextClientPermanentErrorV2("project_closed"));
    expect(errors.map((error) => error.code)).toEqual(["project_closed"]);
    unsubscribe();
    x.client.destroy();
  });
  it("keeps rename identity stable and evicts only clean LRU with awareness cleanup", async () => {
    const first = await setup(); const replacement = await setup(new IDBFactory()); await first.client.connect(); await replacement.client.connect(); first.transports[0].custom?.(ack(first.client.doc)); replacement.transports[0].custom?.(ack(replacement.client.doc)); await first.client.settled(); await replacement.client.settled(); const pool = new CollabTextProviderPoolV2(1); pool.add(first.client); pool.add(replacement.client); expect(pool.size).toBe(1); expect(first.transports[0].clearAwareness).toHaveBeenCalled(); expect(pool.rename(replacement.client, "renamed.tex")).toBe(replacement.client);
  });
  it("protects main, secondary, draft, and outbox entries, then re-evicts after ACK", async () => {
    const a = await setup(); const b = await setup(new IDBFactory(), { ...namespace, fileId: "b" }); const pool = new CollabTextProviderPoolV2(1); pool.add(a.client); const main = pool.pin(a.client, "main"); const secondary = pool.pin(a.client, "secondary"); pool.add(b.client); pool.setDraft(b.client, true); expect(pool.size).toBe(2); main.release(); main.release(); secondary.release(); pool.setDraft(b.client, false); expect(pool.size).toBe(2); // Neither unacknowledged remote-open entry may masquerade as clean.
    await a.client.connect(); a.client.doc.getText("x").insert(0, "pending"); await a.client.settled(); a.transports[0].custom?.(ack(a.client.doc)); await vi.waitFor(() => expect(pool.size).toBe(1));
  });

  it("writes the snapshot record once while local updates accumulate as separate outbox records", async () => {
    class CountingStore extends CollabTextDurableStoreV2 { writes = 0; protected override async write(value: Parameters<CollabTextDurableStoreV2["write"]>[0]) { this.writes++; return super.write(value); } }
    const store = new CountingStore(new IDBFactory(), 0);
    const doc = new Y.Doc();
    doc.getText("x").insert(0, "a");
    await store.persistLocal(namespace, doc, { id: "e1", update: Y.encodeStateAsUpdate(doc), createdAt: 1 });
    doc.getText("x").insert(1, "b");
    await store.persistLocal(namespace, doc, { id: "e2", update: Y.encodeStateAsUpdate(doc), createdAt: 2 });
    // The per-keystroke amplification is gone: one document record write total.
    expect(store.writes).toBe(1);
    expect((await store.load(namespace))?.outbox.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  it("throttles snapshot rewrites and always serves the latest persisted state", async () => {
    let now = 1_000;
    class CountingStore extends CollabTextDurableStoreV2 { writes = 0; protected override async write(value: Parameters<CollabTextDurableStoreV2["write"]>[0]) { this.writes++; return super.write(value); } }
    const store = new CountingStore(new IDBFactory(), 2_000, () => now);
    const doc = new Y.Doc(); doc.getText("x").insert(0, "a");
    await store.persistSnapshot(namespace, doc);
    doc.getText("x").insert(1, "b");
    await store.persistSnapshot(namespace, doc);
    expect(store.writes).toBe(1);
    now += 3_000;
    await store.persistSnapshot(namespace, doc);
    expect(store.writes).toBe(2);
    const reloaded = new Y.Doc(); Y.applyUpdate(reloaded, (await store.load(namespace))!.snapshot);
    expect(reloaded.getText("x").toString()).toBe("ab");
  });
});
