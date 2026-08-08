import { afterEach, describe, expect, it, vi } from "vitest";
import { toRichText } from "tldraw";
import * as Y from "yjs";
import type { CatalogFileV2, CatalogV2 } from "../protocol/collab-v2";
import { planCatalogDeltaV2 } from "./collab-project-v2";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

function file(partial: Partial<CatalogFileV2> & { fileId: string; path: string }): CatalogFileV2 {
  return { kind: "text", state: "live", documentEpoch: 1, ...partial };
}

function catalog(files: CatalogFileV2[], catalogRevision = 1): CatalogV2 {
  return {
    protocol: 2,
    projectInstanceId: "project-1",
    lifecycle: "live",
    catalogRevision,
    snapshotGeneration: 1,
    workspaceLeaseGeneration: 1,
    authorityEpoch: 1,
    files,
  };
}

function boardShape(id: string, index: string, x: number, y: number) {
  return {
    id, typeName: "shape", type: "geo", x, y, rotation: 0,
    index, parentId: "page:page", isLocked: false, opacity: 1, meta: {},
    props: {
      geo: "rectangle", dash: "draw", url: "", w: 20, h: 20,
      growY: 0, scale: 1, labelColor: "black", color: "black",
      fill: "none", size: "m", font: "draw", align: "middle",
      verticalAlign: "middle", richText: toRichText(""),
    },
  };
}

describe("planCatalogDeltaV2", () => {
  it("reports nothing when only the revision moves", () => {
    const files = [file({ fileId: "a", path: "main.tex" })];
    const delta = planCatalogDeltaV2(catalog(files, 1), catalog(files.map((f) => ({ ...f })), 2));
    expect(delta).toEqual({ created: [], renamed: [], deleted: [], staleBinaries: [] });
  });

  it("creates files that become live and ignores non-live newcomers", () => {
    const next = catalog([
      file({ fileId: "a", path: "main.tex" }),
      file({ fileId: "b", path: "new.tex" }),
      file({ fileId: "c", path: "draft.tex", state: "initializing" }),
    ], 2);
    const delta = planCatalogDeltaV2(catalog([file({ fileId: "a", path: "main.tex" })]), next);
    expect(delta.created.map((f) => f.path)).toEqual(["new.tex"]);
    expect(delta.deleted).toEqual([]);
  });

  it("renames files that keep their epoch", () => {
    const before = catalog([file({ fileId: "a", path: "old/intro.tex" })]);
    const after = catalog([file({ fileId: "a", path: "chapters/intro.tex" })], 2);
    const delta = planCatalogDeltaV2(before, after);
    expect(delta.renamed).toEqual([{ file: after.files[0], previousPath: "old/intro.tex" }]);
    expect(delta.created).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });

  it("deletes files that leave the live set or vanish", () => {
    const before = catalog([
      file({ fileId: "a", path: "keep.tex" }),
      file({ fileId: "b", path: "gone.tex" }),
      file({ fileId: "c", path: "dying.tex" }),
    ]);
    const after = catalog([
      file({ fileId: "a", path: "keep.tex" }),
      file({ fileId: "c", path: "dying.tex", state: "tombstoned" }),
    ], 2);
    const delta = planCatalogDeltaV2(before, after);
    expect(delta.deleted).toEqual([
      { fileId: "b", path: "gone.tex" },
      { fileId: "c", path: "dying.tex" },
    ]);
  });

  it("treats an epoch bump as a rewrite at the new path plus cleanup of the old", () => {
    const before = catalog([file({ fileId: "a", path: "old.tex", documentEpoch: 1 })]);
    const after = catalog([file({ fileId: "a", path: "new.tex", documentEpoch: 2 })], 2);
    const delta = planCatalogDeltaV2(before, after);
    expect(delta.created).toEqual([after.files[0]]);
    expect(delta.renamed).toEqual([]);
    expect(delta.deleted).toEqual([{ fileId: "a", path: "old.tex" }]);
  });

  it("flags binaries whose content moved, but not text files or untouched binaries", () => {
    const before = catalog([
      file({ fileId: "t", path: "main.tex" }),
      file({ fileId: "b1", path: "fig.png", kind: "binary", hash: "h1", contentRevision: 1 }),
      file({ fileId: "b2", path: "plot.pdf", kind: "binary", hash: "h2", contentRevision: 3 }),
    ]);
    const after = catalog([
      file({ fileId: "t", path: "main.tex" }),
      file({ fileId: "b1", path: "fig.png", kind: "binary", hash: "h1", contentRevision: 1 }),
      file({ fileId: "b2", path: "plot.pdf", kind: "binary", hash: "h3", contentRevision: 4 }),
    ], 2);
    const delta = planCatalogDeltaV2(before, after);
    expect(delta.staleBinaries).toEqual([after.files[2]]);
  });
});

describe("v2 project presence", () => {
  async function setupPresenceTest(options: {
    paths?: string[];
    boardPaths?: string[];
    presenceTable?: Record<string, unknown>;
    syncManually?: boolean;
    /** Seed the durable store (e.g. a server-acked snapshot) before the controller starts. */
    primeStore?: (store: import("./collab-text-v2-store").CollabTextDurableStoreV2) => Promise<void>;
  } = {}) {
    vi.resetModules();
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const { IDBFactory } = await import("fake-indexeddb");
    const { Awareness } = await import("y-protocols/awareness");
    const paths = options.paths ?? ["paper.md"];
    const catalogValue = {
      protocol: 2, projectInstanceId: "proj", lifecycle: "live", catalogRevision: 1,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1,
      files: [
        ...paths.map((path, index) => ({ fileId: `f${index}`, path, kind: "text", state: "live", documentEpoch: 1 })),
        ...(options.boardPaths ?? []).map((path, index) => ({ fileId: `b${index}`, path, kind: "board", state: "live", documentEpoch: 1 })),
      ],
    };
    const presenceCalls: Array<Record<string, unknown>> = [];
    const awarenesses: InstanceType<typeof Awareness>[] = [];
    const syncedListeners: Array<(synced: boolean) => void> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/catalog")) return respond(catalogValue);
      if (url.includes("/events")) return respond({ catalogRevision: 1, events: [], refetch: false });
      if (url.endsWith("/tickets")) return respond({ ticket: "ticket" });
      if (url.endsWith("/presence")) { presenceCalls.push(JSON.parse(init?.body ?? "{}")); return respond({ protocol: 2, presence: options.presenceTable ?? {} }); }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { CollabProjectControllerV2 } = await import("./collab-project-v2");
    const peersCalls: import("./collab-session").CollabPeer[][] = [];
    const store = new (await import("./collab-text-v2-store")).CollabTextDurableStoreV2(new IDBFactory());
    await options.primeStore?.(store);
    const disconnectListeners: Array<(error?: unknown) => void> = [];
    const controller = await CollabProjectControllerV2.start({
      deployment: "https://collab.example", projectInstanceId: "proj",
      credentialRef: "ref", credentialStore: { get: async () => "secret" } as never,
      store,
      transportFactory: ({ doc }) => {
        const awareness = new Awareness(doc);
        awarenesses.push(awareness);
        return {
          awareness,
          onCustomMessage: () => () => undefined,
          onDisconnect: (listener) => {
            disconnectListeners.push(listener);
            return () => undefined;
          },
          onSynced: (listener) => {
            if (options.syncManually) syncedListeners.push(listener);
            else queueMicrotask(() => listener(true));
            return () => undefined;
          },
          clearAwareness: () => awareness.setLocalState(null),
          destroy: () => awareness.destroy(),
        };
      },
      eventsPollIntervalMs: 5,
      displayName: "Ada",
      onPeers: (peers) => peersCalls.push(peers),
    });
    return { controller, presenceCalls, peersCalls, awarenesses, store, catalogValue, syncedListeners, disconnectListeners };
  }

  it("announces identity and path on awareness, merges cross-file presence, and leaves on destroy", async () => {
    const { controller, presenceCalls, peersCalls } = await setupPresenceTest({
      presenceTable: { "other-instance": { name: "Bo", color: "#123456", path: "notes.md", updatedAt: 1, grantId: "grant-bo" } },
    });
    await controller.openPath("paper.md");
    const local = controller.provider.awareness.getLocalState() as { user?: { name?: string }; path?: string; instanceId?: string };
    expect(local.user?.name).toBe("Ada");
    expect(local.path).toBe("paper.md");
    expect(typeof local.instanceId).toBe("string");
    await vi.waitFor(() => expect(peersCalls.flat().some((peer) => peer.name === "Bo" && peer.path === "notes.md" && peer.grantId === "grant-bo")).toBe(true));
    await vi.waitFor(() => expect(presenceCalls.some((call) => call.name === "Ada" && call.path === "paper.md")).toBe(true));
    controller.destroy();
    await vi.waitFor(() => expect(presenceCalls.some((call) => call.leave === true)).toBe(true));
  });

  it("does not double-count a same-file peer visible in both awareness and presence", async () => {
    const { controller, peersCalls } = await setupPresenceTest({
      presenceTable: { "other-instance": { name: "Bo", color: "#123456", path: "paper.md", updatedAt: 1, grantId: "grant-bo" } },
    });
    await controller.openPath("paper.md");
    const awareness = controller.provider.awareness;
    awareness.states.set(999, { user: { name: "Bo", color: "#123456" }, path: "paper.md", instanceId: "other-instance" });
    awareness.emit("change", [{ added: [999], updated: [], removed: [] }, "local"]);
    await vi.waitFor(() => {
      const latest = peersCalls.at(-1) ?? [];
      expect(latest.filter((peer) => peer.name === "Bo")).toHaveLength(1);
      expect(latest.find((peer) => peer.name === "Bo")?.clientId).toBe(999);
      expect(latest.find((peer) => peer.name === "Bo")?.grantId).toBe("grant-bo");
    });
  });

  it("retracts the announcement from the previous file's room when switching files", async () => {
    const { controller, awarenesses } = await setupPresenceTest({ paths: ["paper.md", "notes.md"] });
    await controller.openPath("paper.md");
    await controller.openPath("notes.md");
    expect(awarenesses).toHaveLength(2);
    expect(awarenesses[0]!.getLocalState()).toBeNull();
    expect((awarenesses[1]!.getLocalState() as { path?: string }).path).toBe("notes.md");
  });

  it("warms a superseded file without activating it over the latest navigation", async () => {
    const { controller } = await setupPresenceTest({ paths: ["paper.md", "notes.md"] });
    await controller.openPath("paper.md", "main", { activateIf: () => false });
    expect(controller.activePath).toBe("");
    await controller.openPath("notes.md");
    expect(controller.activePath).toBe("notes.md");
    controller.destroy();
  });

  it("rejects a client whose catalog epoch changes while synchronization is pending", async () => {
    const { controller, catalogValue, syncedListeners } = await setupPresenceTest({ syncManually: true });
    const opening = controller.openPath("paper.md");
    await vi.waitFor(() => expect(syncedListeners).toHaveLength(1));
    catalogValue.files[0]!.documentEpoch = 2;
    catalogValue.catalogRevision = 2;
    await controller.refetchCatalog();
    syncedListeners[0]!(true);

    await expect(opening).rejects.toThrow("File changed while opening");
    expect(controller.activePath).toBe("");
    controller.destroy();
  });

  it("rejects shared waiters cleanly when a file is renamed during synchronization", async () => {
    const { controller, catalogValue, syncedListeners } = await setupPresenceTest({ syncManually: true });
    const oldPath = controller.openPath("paper.md");
    await vi.waitFor(() => expect(syncedListeners).toHaveLength(1));
    catalogValue.files[0]!.path = "renamed.md";
    catalogValue.catalogRevision = 2;
    await controller.refetchCatalog();
    const newPath = controller.openPath("renamed.md");
    syncedListeners[0]!(true);

    await expect(oldPath).rejects.toThrow("File changed while opening");
    await expect(newPath).rejects.toThrow("File changed while opening");
    expect(controller.activePath).toBe("");

    const retry = controller.openPath("renamed.md");
    await vi.waitFor(() => expect(syncedListeners).toHaveLength(2));
    syncedListeners[1]!(true);
    await expect(retry).resolves.toBeDefined();
    expect(controller.activePath).toBe("renamed.md");
    controller.destroy();
  });

  it("coalesces concurrent uncached opens without destroying either caller's client", async () => {
    const { controller, awarenesses, store } = await setupPresenceTest();
    const originalLoad = store.load.bind(store);
    let loadCount = 0;
    let releaseLoads!: () => void;
    const loadsReleased = new Promise<void>((resolve) => { releaseLoads = resolve; });
    vi.spyOn(store, "load").mockImplementation(async (namespace) => {
      loadCount += 1;
      await loadsReleased;
      return originalLoad(namespace);
    });

    const first = controller.openPath("paper.md");
    const second = controller.openPath("paper.md");
    await vi.waitFor(() => expect(loadCount).toBe(1));
    releaseLoads();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(awarenesses).toHaveLength(1);
    controller.destroy();
  });

  it("rejects every shared open waiter when the controller is destroyed during restore", async () => {
    const { controller, awarenesses, store } = await setupPresenceTest();
    const originalLoad = store.load.bind(store);
    let loadCount = 0;
    let releaseLoad!: () => void;
    const loadReleased = new Promise<void>((resolve) => { releaseLoad = resolve; });
    vi.spyOn(store, "load").mockImplementation(async (namespace) => {
      loadCount += 1;
      await loadReleased;
      return originalLoad(namespace);
    });

    const first = controller.openPath("paper.md");
    const second = controller.openPath("paper.md");
    await vi.waitFor(() => expect(loadCount).toBe(1));
    controller.destroy();
    releaseLoad();

    await expect(first).rejects.toThrow("Controller is destroyed");
    await expect(second).rejects.toThrow("Controller is destroyed");
    expect(awarenesses).toHaveLength(0);
  });

  it("coalesces awareness bursts into one peer render and cancels it on destroy", async () => {
    const { controller, awarenesses, peersCalls } = await setupPresenceTest();
    await controller.openPath("paper.md");
    (controller as unknown as { stopEventsPolling(): void }).stopEventsPolling();
    const awareness = awarenesses[0]!;
    awareness.states.set(999, {
      instanceId: "peer",
      path: "paper.md",
      user: { name: "Bo", color: "#1971c2" },
    });
    const before = peersCalls.length;
    for (let index = 0; index < 20; index++) {
      awareness.emit("change", [{ added: [], updated: [999], removed: [] }, "remote"]);
    }
    expect(peersCalls).toHaveLength(before);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peersCalls).toHaveLength(before + 1);

    awareness.emit("change", [{ added: [], updated: [999], removed: [] }, "remote"]);
    controller.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peersCalls).toHaveLength(before + 1);
  });

  it("coalesces a burst of remote text transactions into one latest-state disk write", async () => {
    const { controller } = await setupPresenceTest();
    const writes: string[] = [];
    let blockWrites = false;
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    controller.bindWorkspace(
      { projectRoot: "/tmp/proj", isCurrent: () => true },
      {
        writeText: async (_path, content) => {
          writes.push(content);
          if (blockWrites) await writeReleased;
        },
        writeBytes: async () => undefined,
      },
    );
    await controller.openPath("paper.md");
    await controller.flush();
    writes.length = 0;

    const remote = new Y.Doc();
    const remoteText = remote.getText("content");
    const applyCharacter = (character: string) => {
      const before = Y.encodeStateVector(remote);
      remoteText.insert(remoteText.length, character);
      Y.applyUpdate(controller.doc, Y.encodeStateAsUpdate(remote, before));
    };
    blockWrites = true;
    applyCharacter("s");
    await vi.waitFor(() => expect(writes).toEqual(["s"]));
    for (const character of "mooth") {
      applyCharacter(character);
    }
    let flushed = false;
    const flush = controller.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    blockWrites = false;
    releaseWrite();
    await flush;

    expect(writes).toEqual(["s", "smooth"]);
    controller.destroy();
  });

  it("keeps an in-flight disk write in flush after its observer is detached", async () => {
    const { controller } = await setupPresenceTest();
    let releaseWrite!: () => void;
    let blockWrite = false;
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writes: string[] = [];
    controller.bindWorkspace(
      { projectRoot: "/tmp/proj", isCurrent: () => true },
      {
        writeText: async (_path, content) => {
          writes.push(content);
          if (blockWrite) await writeReleased;
        },
        writeBytes: async () => undefined,
      },
    );
    await controller.openPath("paper.md");
    await controller.flush();
    writes.length = 0;

    blockWrite = true;
    const peer = new Y.Doc();
    peer.getText("content").insert(0, "remote");
    Y.applyUpdate(controller.doc, Y.encodeStateAsUpdate(peer));
    await vi.waitFor(() => expect(writes).toEqual(["remote"]));
    (controller as unknown as { detachDiskObserver(fileId: string): void }).detachDiskObserver("f0");
    let flushed = false;
    const flush = controller.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    blockWrite = false;
    releaseWrite();
    await flush;
    expect(flushed).toBe(true);
    controller.destroy();
  });

  /** Seed f0 with a server-acked snapshot so the restored doc counts as durable-seen. */
  async function primeAckedSnapshot(store: import("./collab-text-v2-store").CollabTextDurableStoreV2, text: string) {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    const snapshot = Y.encodeStateAsUpdate(doc);
    const vector = Y.encodeStateVector(doc);
    const stateVector = btoa(String.fromCharCode(...vector))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const namespace = { deployment: "https://collab.example", projectInstanceId: "proj", fileId: "f0", documentEpoch: 1 };
    await store.compactAck(namespace, snapshot, {
      type: "lattice.durable-ack",
      protocol: 2,
      projectInstanceId: "proj",
      fileId: "f0",
      documentEpoch: 1,
      contentRevision: 1,
      snapshotGeneration: 1,
      stateVector,
      size: snapshot.byteLength,
      hash: "a".repeat(64),
    }, vector);
  }

  it("cached-first open returns the acked snapshot before the transport ever syncs", async () => {
    const { controller, syncedListeners } = await setupPresenceTest({
      syncManually: true,
      primeStore: (store) => primeAckedSnapshot(store, "cached text"),
    });
    // syncManually means no transport ever reports synced — resolving at all
    // proves the open did not wait on the network.
    const ytext = await controller.openPath("paper.md", "main", { cachedFirst: true, timeoutMs: 500 });
    expect(ytext.toString()).toBe("cached text");
    // The background connection is still attempted (transport materializes
    // once the ticket fetch lands).
    await vi.waitFor(() => expect(syncedListeners.length).toBeGreaterThan(0));
    controller.destroy();
  });

  it("cached-first open without a durable snapshot still waits for sync", async () => {
    const { controller, syncedListeners } = await setupPresenceTest({ syncManually: true });
    let resolved = false;
    const opening = controller.openPath("paper.md", "main", { cachedFirst: true, timeoutMs: 5_000 })
      .then((ytext) => { resolved = true; return ytext; });
    await vi.waitFor(() => expect(syncedListeners.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    syncedListeners.forEach((listener) => listener(true));
    await opening;
    expect(resolved).toBe(true);
    controller.destroy();
  });

  it("a permanent close during a cached-first session still drops canWrite", async () => {
    const { controller, disconnectListeners } = await setupPresenceTest({
      syncManually: true,
      primeStore: (store) => primeAckedSnapshot(store, "cached text"),
    });
    const { TextClientPermanentErrorV2 } = await import("./collab-text-v2");
    await controller.openPath("paper.md", "main", { cachedFirst: true, timeoutMs: 500 });
    const canWrites: boolean[] = [];
    const unsubscribe = controller.subscribeCanWrite((value) => canWrites.push(value));
    expect(canWrites.at(-1)).toBe(true);
    // The server's write gate closes the socket permanently (4403 maps to
    // "revoked"); the cached-first client must stop and report read-only.
    // Wait for the background connection to attach its transport first.
    await vi.waitFor(() => expect(disconnectListeners.length).toBeGreaterThan(0));
    disconnectListeners.forEach((listener) => listener(new TextClientPermanentErrorV2("revoked")));
    await vi.waitFor(() => expect(controller.canWrite).toBe(false));
    unsubscribe();
    controller.destroy();
  });
});

describe("v2 board disk mirroring", () => {
  it("mirrors local and remote board record edits onto disk as serialized .tldr", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const { IDBFactory } = await import("fake-indexeddb");
    const { Awareness } = await import("y-protocols/awareness");
    const Y = await import("yjs");
    const catalogValue = {
      protocol: 2, projectInstanceId: "proj", lifecycle: "live", catalogRevision: 1,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1,
      files: [{ fileId: "b0", path: "sketch.tldr", kind: "board", state: "live", documentEpoch: 1 }],
    };
    const fetchMock = vi.fn(async (url: string) => {
      const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/catalog")) return respond(catalogValue);
      if (url.includes("/events")) return respond({ catalogRevision: 1, events: [], refetch: false });
      if (url.endsWith("/tickets")) return respond({ ticket: "ticket" });
      if (url.endsWith("/presence")) return respond({ protocol: 2, presence: {} });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { CollabProjectControllerV2 } = await import("./collab-project-v2");
    const writes: Array<{ path: string; content: string }> = [];
    const controller = await CollabProjectControllerV2.start({
      deployment: "https://collab.example", projectInstanceId: "proj",
      credentialRef: "ref", credentialStore: { get: async () => "secret" } as never,
      store: new (await import("./collab-text-v2-store")).CollabTextDurableStoreV2(new IDBFactory()),
      transportFactory: ({ doc }) => {
        const awareness = new Awareness(doc);
        return {
          awareness,
          onCustomMessage: () => () => undefined,
          onDisconnect: () => () => undefined,
          onSynced: (listener) => { queueMicrotask(() => listener(true)); return () => undefined; },
          clearAwareness: () => awareness.setLocalState(null),
          destroy: () => awareness.destroy(),
        };
      },
      eventsPollIntervalMs: 5,
      displayName: "Ada",
    });
    controller.bindWorkspace(
      { projectRoot: "/tmp/proj", isCurrent: () => true },
      { writeText: async (path, content) => { writes.push({ path, content }); }, writeBytes: async () => undefined },
    );
    await controller.openPath("sketch.tldr");

    // A peer's edit lands as a remote update on the records map.
    const peer = new Y.Doc();
    peer.getMap("records").set("shape:one", boardShape("shape:one", "a1", 1, 2));
    Y.applyUpdate(controller.doc, Y.encodeStateAsUpdate(peer));

    await vi.waitFor(() => expect(writes.some((write) => write.path === "sketch.tldr")).toBe(true));
    const written = writes.find((write) => write.path === "sketch.tldr")!;
    const parsed = JSON.parse(written.content) as { tldrawFileFormatVersion: number; records: Array<{ id: string }> };
    expect(parsed.tldrawFileFormatVersion).toBe(1);
    expect(parsed.records.map((record) => record.id)).toContain("shape:one");
    // The imported content text is a historical artifact, not the live state.
    expect(controller.doc.getText("content").toString()).not.toContain("shape:one");

    writes.length = 0;
    controller.doc.getMap("records").set("shape:local", boardShape("shape:local", "a2", 3, 4));
    await controller.flush();
    expect(writes.some((write) => write.content.includes("shape:local"))).toBe(true);
    controller.destroy();
  });
});

describe("v2 awareness rebinding after reconnect", () => {
  it("follows the client's new Awareness and re-announces identity after a transport reconnect", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const { IDBFactory } = await import("fake-indexeddb");
    const { Awareness } = await import("y-protocols/awareness");
    const catalogValue = {
      protocol: 2, projectInstanceId: "proj", lifecycle: "live", catalogRevision: 1,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1,
      files: [{ fileId: "f0", path: "paper.md", kind: "text", state: "live", documentEpoch: 1 }],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/catalog")) return respond(catalogValue);
      if (url.includes("/events")) return respond({ catalogRevision: 1, events: [], refetch: false });
      if (url.endsWith("/tickets")) return respond({ ticket: "ticket" });
      if (url.endsWith("/presence")) return respond({ protocol: 2, presence: {} });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const awarenesses: InstanceType<typeof Awareness>[] = [];
    const disconnects: Array<(error?: unknown) => void> = [];
    let reconnectTask: (() => void) | undefined;
    const { CollabProjectControllerV2 } = await import("./collab-project-v2");
    const controller = await CollabProjectControllerV2.start({
      deployment: "https://collab.example", projectInstanceId: "proj",
      credentialRef: "ref", credentialStore: { get: async () => "secret" } as never,
      store: new (await import("./collab-text-v2-store")).CollabTextDurableStoreV2(new IDBFactory()),
      transportFactory: ({ doc }) => {
        const awareness = new Awareness(doc);
        awarenesses.push(awareness);
        return {
          awareness,
          onCustomMessage: () => () => undefined,
          onDisconnect: (listener) => { disconnects.push(listener); return () => undefined; },
          onSynced: (listener) => { queueMicrotask(() => listener(true)); return () => undefined; },
          clearAwareness: () => awareness.setLocalState(null),
          destroy: () => awareness.destroy(),
        };
      },
      reconnectPolicy: { schedule: (task) => { reconnectTask = task; return 1; }, cancel: () => undefined, delay: () => 0 },
      eventsPollIntervalMs: 5,
      displayName: "Ada",
    });
    await controller.openPath("paper.md");
    expect(controller.provider.awareness).toBe(awarenesses[0]);
    const versionBefore = controller.awarenessVersion;

    // Transport drops: the client tears it down and schedules a reconnect.
    disconnects[0]!();
    expect(controller.provider.awareness).not.toBe(awarenesses[0]);
    expect(reconnectTask).toBeDefined();

    reconnectTask!();
    await vi.waitFor(() => expect(awarenesses).toHaveLength(2));
    await vi.waitFor(() => expect(controller.provider.awareness).toBe(awarenesses[1]));
    expect(controller.awarenessVersion).toBeGreaterThan(versionBefore);
    // Identity/path re-announced on the live Awareness — the old one is dead.
    const local = awarenesses[1]!.getLocalState() as { user?: { name?: string }; path?: string };
    expect(local.user?.name).toBe("Ada");
    expect(local.path).toBe("paper.md");
    controller.destroy();
  });
});


describe("v2 board presence identity", () => {
  it("returns a stable object across accesses (React effect deps downstream)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const { IDBFactory } = await import("fake-indexeddb");
    const { Awareness } = await import("y-protocols/awareness");
    const catalogValue = {
      protocol: 2, projectInstanceId: "proj", lifecycle: "live", catalogRevision: 1,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1,
      files: [{ fileId: "f0", path: "paper.md", kind: "text", state: "live", documentEpoch: 1 }],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/catalog")) return respond(catalogValue);
      if (url.includes("/events")) return respond({ catalogRevision: 1, events: [], refetch: false });
      if (url.endsWith("/presence")) return respond({ protocol: 2, presence: {} });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const { CollabProjectControllerV2 } = await import("./collab-project-v2");
    const controller = await CollabProjectControllerV2.start({
      deployment: "https://collab.example", projectInstanceId: "proj",
      credentialRef: "ref", credentialStore: { get: async () => "secret" } as never,
      store: new (await import("./collab-text-v2-store")).CollabTextDurableStoreV2(new IDBFactory()),
      transportFactory: ({ doc }) => {
        const awareness = new Awareness(doc);
        return {
          awareness,
          onCustomMessage: () => () => undefined,
          onDisconnect: () => () => undefined,
          onSynced: (listener) => { queueMicrotask(() => listener(true)); return () => undefined; },
          clearAwareness: () => awareness.setLocalState(null),
          destroy: () => awareness.destroy(),
        };
      },
      eventsPollIntervalMs: 5,
      displayName: "Ada",
    });
    const first = controller.boardPresenceUser;
    expect(controller.boardPresenceUser).toBe(first);
    expect(first.name).toBe("Ada");
    expect(first.color).toMatch(/^#/);
    controller.destroy();
  });
});

describe("v2 mid-share file creation", () => {
  async function setupCreateTest(options: {
    permission?: "host" | "write" | "read";
    /** Flip the created file to live as soon as a catalog pull follows the create. */
    hostOnline?: boolean;
    /** First /create answers 409 catalog_revision_conflict (a peer moved the revision first). */
    failFirstCreate?: boolean;
    /** Durable text initialization fails, including its one idempotent retry. */
    failImport?: boolean;
    initializingFiles?: Array<{ fileId: string; path: string }>;
    /** Seed extra files that are already live in the catalog. */
    liveFiles?: Array<{ fileId: string; path: string }>;
  } = {}) {
    vi.resetModules();
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const { IDBFactory } = await import("fake-indexeddb");
    const { Awareness } = await import("y-protocols/awareness");
    const catalogValue = {
      protocol: 2, projectInstanceId: "proj", lifecycle: "live", catalogRevision: 1,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1,
      files: [
        { fileId: "f0", path: "paper.md", kind: "text", state: "live", documentEpoch: 1 },
        ...(options.initializingFiles ?? []).map((entry) => ({ fileId: entry.fileId, path: entry.path, kind: "text", state: "initializing", documentEpoch: 1 })),
        ...(options.liveFiles ?? []).map((entry) => ({ fileId: entry.fileId, path: entry.path, kind: "text", state: "live", documentEpoch: 1 })),
      ] as Array<{ fileId: string; path: string; kind: string; state: string; documentEpoch: number }>,
    };
    const calls = { create: 0, fileReady: 0, textImport: 0, importedText: "" };
    let createSeen = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/catalog")) {
        if (createSeen && options.hostOnline) {
          const pending = catalogValue.files.find((entry) => entry.state === "initializing" && entry.fileId.startsWith("created-"));
          if (pending) pending.state = "live";
        }
        return respond(catalogValue);
      }
      if (url.includes("/events")) return respond({ catalogRevision: catalogValue.catalogRevision, events: [], refetch: false });
      if (url.endsWith("/tickets")) return respond({ ticket: "ticket" });
      if (url.endsWith("/presence")) return respond({ protocol: 2, presence: {} });
      if (url.includes("/text/imports/")) {
        calls.textImport += 1;
        if (options.failImport) return new Response(JSON.stringify({ error: "import_failed" }), { status: 503, headers: { "content-type": "application/json" } });
        const fileId = decodeURIComponent(url.split("/").at(-1)!);
        const entry = catalogValue.files.find((candidate) => candidate.fileId === fileId)!;
        const body = init?.body as unknown as Uint8Array;
        calls.importedText = new TextDecoder().decode(body);
        entry.state = "live";
        catalogValue.catalogRevision += 1;
        return respond({ status: "created" });
      }
      if (url.endsWith("/create")) {
        calls.create += 1;
        createSeen = true;
        const body = JSON.parse(init?.body ?? "{}") as { path: string; kind: string };
        if (options.failFirstCreate && calls.create === 1) {
          // A peer's op landed first: the revision moved, so this expectedCatalogRevision is stale.
          catalogValue.catalogRevision += 1;
          return new Response(JSON.stringify({ error: "catalog_revision_conflict", message: "Catalog revision conflict" }), { status: 409, headers: { "content-type": "application/json" } });
        }
        const created = { fileId: `created-${calls.create}`, path: body.path, kind: body.kind, state: "initializing", documentEpoch: 1 };
        catalogValue.files.push(created);
        catalogValue.catalogRevision += 1;
        return respond({ operationId: body && "op", status: "complete", catalogRevision: catalogValue.catalogRevision, value: created });
      }
      if (url.endsWith("/file-ready")) {
        calls.fileReady += 1;
        const body = JSON.parse(init?.body ?? "{}") as { fileId: string };
        const entry = catalogValue.files.find((candidate) => candidate.fileId === body.fileId);
        if (!entry || entry.state !== "initializing") return new Response(JSON.stringify({ error: "not_initializing", message: "File is not initializing" }), { status: 409, headers: { "content-type": "application/json" } });
        entry.state = "live";
        catalogValue.catalogRevision += 1;
        return respond({ operationId: "op", status: "complete", catalogRevision: catalogValue.catalogRevision, value: entry });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const { CollabProjectControllerV2 } = await import("./collab-project-v2");
    const controller = await CollabProjectControllerV2.start({
      deployment: "https://collab.example", projectInstanceId: "proj",
      credentialRef: "ref", credentialStore: { get: async () => "secret" } as never,
      permission: options.permission,
      store: new (await import("./collab-text-v2-store")).CollabTextDurableStoreV2(new IDBFactory()),
      transportFactory: ({ doc }) => {
        const awareness = new Awareness(doc);
        return {
          awareness,
          onCustomMessage: () => () => undefined,
          onDisconnect: () => () => undefined,
          onSynced: (listener) => { queueMicrotask(() => listener(true)); return () => undefined; },
          clearAwareness: () => awareness.setLocalState(null),
          destroy: () => awareness.destroy(),
        };
      },
      eventsPollIntervalMs: 5,
      displayName: "Ada",
    });
    controller.bindWorkspace(
      { projectRoot: "/tmp/proj", isCurrent: () => true },
      { writeText: async () => undefined, writeBytes: async () => undefined },
    );
    return { controller, catalogValue, calls };
  }

  it("host: durably uploads seed text before the created file becomes live", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "host" });
    await controller.create("notes/new.md", "text", { seedText: "# Notes\n" });
    expect(calls.create).toBe(1);
    expect(calls.textImport).toBe(1);
    expect(calls.importedText).toBe("# Notes\n");
    expect(calls.fileReady).toBe(0);
    const entry = catalogValue.files.find((file) => file.path === "notes/new.md")!;
    expect(entry.state).toBe("live");
    expect(controller.hasTextPath("notes/new.md")).toBe(true);
    controller.destroy();
  });

  it("guest: durably uploads its seed without waiting for the host", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "write", hostOnline: false });
    await controller.create("draft.md", "text", { seedText: "draft body" });
    expect(calls.create).toBe(1);
    expect(calls.textImport).toBe(1);
    expect(calls.importedText).toBe("draft body");
    expect(calls.fileReady).toBe(0);
    expect(catalogValue.files.find((file) => file.path === "draft.md")!.state).toBe("live");
    controller.destroy();
  });

  it("write guest: creates the comments document while the host is offline", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "write", hostOnline: false });
    const comments = JSON.stringify([{ id: "comment-1", body: "Please clarify this paragraph" }]);
    await controller.create(".research/editor-comments.json", "text", { seedText: comments });
    expect(calls.create).toBe(1);
    expect(calls.textImport).toBe(1);
    expect(calls.importedText).toBe(comments);
    expect(calls.fileReady).toBe(0);
    expect(catalogValue.files.find((file) => file.path === ".research/editor-comments.json")!.state).toBe("live");
    controller.destroy();
  });

  it("durably initializes an empty text file instead of using file-ready", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "host" });
    await controller.create("empty.md", "text");
    expect(calls.textImport).toBe(1);
    expect(calls.importedText).toBe("");
    expect(calls.fileReady).toBe(0);
    expect(catalogValue.files.find((file) => file.path === "empty.md")!.state).toBe("live");
    controller.destroy();
  });

  it("does not publish a text file when durable initialization fails", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "write", failImport: true });
    await expect(controller.create("stuck.md", "text", { seedText: "must persist" })).rejects.toThrow(/text_import_failed/);
    expect(calls.textImport).toBe(2);
    expect(catalogValue.files.find((file) => file.path === "stuck.md")!.state).toBe("initializing");
    controller.destroy();
  });

  it("read-only collaborators cannot create files", async () => {
    const { controller, calls } = await setupCreateTest({ permission: "read" });
    await expect(controller.create("nope.md", "text")).rejects.toThrow(/Read-only/);
    expect(calls.create).toBe(0);
    controller.destroy();
  });

  it("host does not publish peer-created text files before they are durably initialized", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({
      permission: "host",
      initializingFiles: [{ fileId: "peer-1", path: "peer/new.md" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.fileReady).toBe(0);
    expect(catalogValue.files.find((file) => file.fileId === "peer-1")!.state).toBe("initializing");
    expect(controller.hasTextPath("peer/new.md")).toBe(false);
    controller.destroy();
  });

  it("retries the create once when a peer moved the catalog revision first", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "host", failFirstCreate: true });
    await controller.create("notes/raced.md", "text", { seedText: "# Raced\n" });
    expect(calls.create).toBe(2);
    expect(calls.textImport).toBe(1);
    expect(calls.fileReady).toBe(0);
    expect(catalogValue.files.find((file) => file.path === "notes/raced.md")!.state).toBe("live");
    controller.destroy();
  });

  it("rejects a path that is already in the catalog", async () => {
    const { controller, calls } = await setupCreateTest({ permission: "host" });
    await expect(controller.create("paper.md", "text")).rejects.toThrow(/already exists/);
    expect(calls.create).toBe(0);
    controller.destroy();
  });

  it("can adopt a same-kind path that a peer created first", async () => {
    const { controller, calls } = await setupCreateTest({ permission: "host" });
    await expect(controller.create("paper.md", "text", { adoptExisting: true })).resolves.toBe(false);
    expect(calls.create).toBe(0);
    controller.destroy();
  });

describe("v2 project chat doc", () => {
  // Reuses the mid-share creation harness above: the chat document is a plain
  // catalog text file, so the same mocked coordinator covers it.
  async function setupChatTest(options: Parameters<typeof setupCreateTest>[0] = {}) {
    return setupCreateTest(options);
  }

  it("host: creates the chat file on first open and reuses the same doc after", async () => {
    const { controller, catalogValue, calls } = await setupChatTest({ permission: "host" });
    const { COLLAB_CHAT_PATH } = await import("./collab-session");
    const doc = await controller.openChatDoc();
    expect(doc).not.toBeNull();
    expect(calls.create).toBe(1);
    expect(catalogValue.files.find((file) => file.path === COLLAB_CHAT_PATH)!.state).toBe("live");
    expect(controller.chatDoc).toBe(doc);
    // Idempotent: no second create, same doc back.
    await expect(controller.openChatDoc()).resolves.toBe(doc);
    expect(calls.create).toBe(1);
    // Chat never steals the primary editor's binding.
    expect(controller.activePath).toBe("");
    controller.destroy();
  });

  it("read guest: returns null (no create) until a writer's chat file is in the catalog", async () => {
    const { controller, calls } = await setupChatTest({ permission: "read" });
    await expect(controller.openChatDoc()).resolves.toBeNull();
    expect(calls.create).toBe(0);
    controller.destroy();
  });

  it("read guest: binds the chat file once it exists in the catalog", async () => {
    const { COLLAB_CHAT_PATH } = await import("./collab-session");
    const { controller, calls } = await setupChatTest({
      permission: "read",
      liveFiles: [{ fileId: "chat-file", path: COLLAB_CHAT_PATH }],
    });
    const doc = await controller.openChatDoc();
    expect(doc).not.toBeNull();
    expect(calls.create).toBe(0);
    expect(controller.chatDoc).toBe(doc);
    controller.destroy();
  });

  it("survives pool eviction pressure from many sideloaded files", async () => {
    const { controller } = await setupChatTest({ permission: "host" });
    const doc = await controller.openChatDoc();
    expect(doc).not.toBeNull();
    // Fill the pool (capacity 8) past its limit with other clean files; the
    // pinned chat client must not be the eviction victim.
    for (let index = 0; index < 9; index += 1) {
      const path = `pressure/file-${index}.md`;
      await controller.create(path, "text", { seedText: `# ${index}\n` });
      await controller.openPath(path, "secondary", { sideload: true });
    }
    expect(controller.chatDoc).toBe(doc);
    const again = await controller.openChatDoc();
    expect(again).toBe(doc);
    controller.destroy();
  });

  it("notifies subscribers with null on destroy", async () => {
    const { controller } = await setupChatTest({ permission: "host" });
    const seen: Array<unknown> = [];
    controller.subscribeChatDoc((value) => seen.push(value));
    const doc = await controller.openChatDoc();
    expect(seen.at(-1)).toBe(doc);
    controller.destroy();
    expect(seen.at(-1)).toBeNull();
  });
});
});
