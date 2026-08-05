import { afterEach, describe, expect, it, vi } from "vitest";
import { toRichText } from "tldraw";
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
  async function setupPresenceTest(options: { paths?: string[]; boardPaths?: string[]; presenceTable?: Record<string, unknown> } = {}) {
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
          onDisconnect: () => () => undefined,
          onSynced: (listener) => { queueMicrotask(() => listener(true)); return () => undefined; },
          clearAwareness: () => awareness.setLocalState(null),
          destroy: () => awareness.destroy(),
        };
      },
      eventsPollIntervalMs: 5,
      displayName: "Ada",
      onPeers: (peers) => peersCalls.push(peers),
    });
    return { controller, presenceCalls, peersCalls, awarenesses };
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
    initializingFiles?: Array<{ fileId: string; path: string }>;
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
      ] as Array<{ fileId: string; path: string; kind: string; state: string; documentEpoch: number }>,
    };
    const calls = { create: 0, fileReady: 0 };
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

  it("host: create is marked live inline and the seed text lands in the fresh doc", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "host" });
    await controller.create("notes/new.md", "text", { seedText: "# Notes\n" });
    expect(calls.create).toBe(1);
    expect(calls.fileReady).toBe(1);
    const entry = catalogValue.files.find((file) => file.path === "notes/new.md")!;
    expect(entry.state).toBe("live");
    expect(controller.hasTextPath("notes/new.md")).toBe(true);
    const ytext = await controller.openPath("notes/new.md", "secondary", { sideload: true });
    expect(ytext.toString()).toBe("# Notes\n");
    controller.destroy();
  });

  it("guest: waits for the host's file-ready instead of calling it, then seeds", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "write", hostOnline: true });
    await controller.create("draft.md", "text", { seedText: "draft body" });
    expect(calls.create).toBe(1);
    expect(calls.fileReady).toBe(0);
    expect(catalogValue.files.find((file) => file.path === "draft.md")!.state).toBe("live");
    const ytext = await controller.openPath("draft.md", "secondary", { sideload: true });
    expect(ytext.toString()).toBe("draft body");
    controller.destroy();
  });

  it("guest: times out while the host is offline and leaves the file initializing", async () => {
    const { controller, catalogValue } = await setupCreateTest({ permission: "write", hostOnline: false });
    await expect(controller.create("stuck.md", "text", { timeoutMs: 700 })).rejects.toThrow(/host/);
    expect(catalogValue.files.find((file) => file.path === "stuck.md")!.state).toBe("initializing");
    controller.destroy();
  });

  it("read-only collaborators cannot create files", async () => {
    const { controller, calls } = await setupCreateTest({ permission: "read" });
    await expect(controller.create("nope.md", "text")).rejects.toThrow(/Read-only/);
    expect(calls.create).toBe(0);
    controller.destroy();
  });

  it("host: peer-created initializing files are marked live on the next catalog pull", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({
      permission: "host",
      initializingFiles: [{ fileId: "peer-1", path: "peer/new.md" }],
    });
    await vi.waitFor(() => expect(calls.fileReady).toBe(1));
    expect(catalogValue.files.find((file) => file.fileId === "peer-1")!.state).toBe("live");
    // The controller's own catalog copy catches up on the next events poll.
    await vi.waitFor(() => expect(controller.hasTextPath("peer/new.md")).toBe(true));
    controller.destroy();
  });

  it("retries the create once when a peer moved the catalog revision first", async () => {
    const { controller, catalogValue, calls } = await setupCreateTest({ permission: "host", failFirstCreate: true });
    await controller.create("notes/raced.md", "text", { seedText: "# Raced\n" });
    expect(calls.create).toBe(2);
    expect(calls.fileReady).toBe(1);
    expect(catalogValue.files.find((file) => file.path === "notes/raced.md")!.state).toBe("live");
    const ytext = await controller.openPath("notes/raced.md", "secondary", { sideload: true });
    expect(ytext.toString()).toBe("# Raced\n");
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
});
