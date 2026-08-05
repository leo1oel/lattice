import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  toRichText,
  type TLCamera,
  type TLInstancePresence,
  type TLPage,
  type TLRecord,
  type TLShape,
} from "tldraw";
import {
  BOARD_CONTENT_KEY,
  BOARD_RECORDS_KEY,
  attachBoardBridge,
  attachBoardPresence,
  boardDocContent,
  createBoardStore,
  parseBoardRecords,
  pruneUnusedAssets,
  seedBoardRecords,
  serializeBoard,
} from "./board-yjs-bridge";

function createStore() {
  return createTLStore({ shapeUtils: [...defaultShapeUtils], bindingUtils: [...defaultBindingUtils] });
}

function makeGeoShape(id: string, x = 0): TLShape {
  return {
    id: createShapeId(id),
    typeName: "shape",
    type: "geo",
    x,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      geo: "rectangle",
      dash: "draw",
      url: "",
      w: 100,
      h: 100,
      growY: 0,
      scale: 1,
      labelColor: "black",
      color: "black",
      fill: "none",
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      richText: toRichText(""),
    },
  } as TLShape;
}

function makePage(id: string, name: string): TLPage {
  return { id: `page:${id}`, typeName: "page", name, index: "a2", meta: {} } as TLPage;
}

function makeCamera(): TLCamera {
  return { id: "camera:page:page", typeName: "camera", x: 1, y: 2, z: 3, meta: {} } as TLCamera;
}

function makeAsset(id: string): TLRecord {
  return {
    id: `asset:${id}`,
    typeName: "asset",
    type: "image",
    meta: {},
    props: { w: 10, h: 10, name: "a.png", isAnimated: false, mimeType: "image/png", src: "assets/a.png" },
  } as unknown as TLRecord;
}

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function syncAwareness(a: Awareness, b: Awareness) {
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), "test");
  applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [b.clientID]), "test");
}

function presenceRecords(store: ReturnType<typeof createStore>): TLInstancePresence[] {
  return store.allRecords().filter((record): record is TLInstancePresence => record.typeName === "instance_presence");
}

describe("serialize/parse round-trip", () => {
  it("round-trips document records through .tldr JSON", () => {
    const store = createStore();
    const shape = makeGeoShape("one");
    store.put([shape, makeCamera()]);
    const json = serializeBoard(store.allRecords());
    const parsed = parseBoardRecords(json);
    expect(parsed).not.toBeNull();
    const ids = parsed!.map((record) => record.id).sort();
    expect(ids).toContain(shape.id);
    expect(ids).toContain("page:page");
    expect(ids).toContain("document:document");
    // Ephemeral records never reach the file format.
    expect(ids).not.toContain("camera:page:page");
    expect(JSON.parse(json).tldrawFileFormatVersion).toBe(1);
  });

  it("produces byte-stable output independent of input order", () => {
    const store = createStore();
    const records = serializeBoard(store.allRecords());
    const reversed = serializeBoard([...store.allRecords()].reverse());
    expect(reversed).toBe(records);
  });

  it("returns null for garbage and empty input", () => {
    expect(parseBoardRecords("not json")).toBeNull();
    expect(parseBoardRecords("")).toBeNull();
    expect(parseBoardRecords("{}")).toBeNull();
  });
});

describe("pruneUnusedAssets", () => {
  it("drops unreferenced assets and keeps referenced ones", () => {
    const used = makeAsset("used");
    const orphan = makeAsset("orphan");
    const shape = {
      ...makeGeoShape("img"),
      props: { ...makeGeoShape("img").props, assetId: used.id },
    } as TLRecord;
    const kept = pruneUnusedAssets([used, orphan, shape]);
    expect(kept.map((record) => record.id)).toEqual([used.id, shape.id]);
  });
});

describe("seedBoardRecords", () => {
  it("promotes imported content into the records map exactly once", () => {
    const store = createStore();
    store.put([makeGeoShape("seeded")]);
    const doc = new Y.Doc();
    doc.getText(BOARD_CONTENT_KEY).insert(0, serializeBoard(store.allRecords()));

    expect(seedBoardRecords(doc)).toBe(true);
    const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
    expect(yRecords.has(createShapeId("seeded"))).toBe(true);
    expect(yRecords.has("page:page")).toBe(true);

    const before = yRecords.size;
    expect(seedBoardRecords(doc)).toBe(false);
    expect(yRecords.size).toBe(before);
  });

  it("is a no-op for empty or invalid content", () => {
    const doc = new Y.Doc();
    expect(seedBoardRecords(doc)).toBe(false);
    doc.getText(BOARD_CONTENT_KEY).insert(0, "garbage");
    expect(seedBoardRecords(doc)).toBe(false);
  });

  it("converges when two peers seed concurrently", () => {
    const store = createStore();
    store.put([makeGeoShape("shared")]);
    const content = serializeBoard(store.allRecords());
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText(BOARD_CONTENT_KEY).insert(0, content);
    b.getText(BOARD_CONTENT_KEY).insert(0, content);
    seedBoardRecords(a);
    seedBoardRecords(b);
    syncDocs(a, b);
    const aIds = [...a.getMap(BOARD_RECORDS_KEY).keys()].sort();
    const bIds = [...b.getMap(BOARD_RECORDS_KEY).keys()].sort();
    expect(aIds).toEqual(bIds);
    expect(aIds).toContain(createShapeId("shared"));
  });
});

describe("boardDocContent", () => {
  it("falls back to imported text before seeding and prefers records after", () => {
    const store = createStore();
    store.put([makeGeoShape("first")]);
    const doc = new Y.Doc();
    doc.getText(BOARD_CONTENT_KEY).insert(0, serializeBoard(store.allRecords()));
    expect(boardDocContent(doc)).toContain(createShapeId("first"));

    seedBoardRecords(doc);
    // A record-only edit is reflected in the serialized content even though
    // the imported text is now stale.
    doc.getMap<TLRecord>(BOARD_RECORDS_KEY).set(makeGeoShape("second").id, makeGeoShape("second"));
    const out = boardDocContent(doc);
    expect(out).toContain(createShapeId("second"));
    expect(doc.getText(BOARD_CONTENT_KEY).toString()).not.toContain(createShapeId("second"));
  });
});

describe("attachBoardBridge", () => {
  it("pushes local document edits into the Y.Doc and keeps ephemeral records local", () => {
    const store = createStore();
    const doc = new Y.Doc();
    const bridge = attachBoardBridge(store, doc);
    const shape = makeGeoShape("local");
    store.put([shape, makeCamera()]);
    const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
    expect(yRecords.get(shape.id)).toMatchObject({ id: shape.id });
    expect(yRecords.has("camera:page:page")).toBe(false);

    store.remove([shape.id]);
    expect(yRecords.has(shape.id)).toBe(false);
    bridge.dispose();
  });

  it("mirrors remote edits into the store across two bridged docs", () => {
    const storeA = createStore();
    const storeB = createStore();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const bridgeA = attachBoardBridge(storeA, docA);
    const bridgeB = attachBoardBridge(storeB, docB);

    const shape = makeGeoShape("remote");
    storeA.put([shape]);
    syncDocs(docA, docB);
    expect(storeB.get(shape.id)).toMatchObject({ id: shape.id, type: "geo" });

    storeA.put([{ ...shape, x: 500 }]);
    syncDocs(docA, docB);
    expect(storeB.get(shape.id)).toMatchObject({ x: 500 });

    storeA.remove([shape.id]);
    syncDocs(docA, docB);
    expect(storeB.get(shape.id)).toBeUndefined();

    bridgeA.dispose();
    bridgeB.dispose();
  });

  it("seeds an empty store from imported content on attach", () => {
    const source = createStore();
    source.put([makeGeoShape("from-import")]);
    const doc = new Y.Doc();
    doc.getText(BOARD_CONTENT_KEY).insert(0, serializeBoard(source.allRecords()));

    const store = createStore();
    expect(store.get(createShapeId("from-import"))).toBeUndefined();
    const bridge = attachBoardBridge(store, doc);
    expect(store.get(createShapeId("from-import"))).toBeDefined();
    bridge.dispose();
  });

  it("treats the doc as authoritative on attach, removing stale store records", () => {
    const storeA = createStore();
    const storeB = createStore();
    const doc = new Y.Doc();
    const bridgeA = attachBoardBridge(storeA, doc);
    const kept = makeGeoShape("kept");
    storeA.put([kept]);
    bridgeA.dispose();

    storeB.put([makeGeoShape("stale"), makePage("extra", "Extra")]);
    expect(storeB.get(kept.id)).toBeUndefined();
    const bridgeB = attachBoardBridge(storeB, doc);
    expect(storeB.get(kept.id)).toBeDefined();
    expect(storeB.get(createShapeId("stale"))).toBeUndefined();
    expect(storeB.get("page:extra" as TLPage["id"])).toBeUndefined();
    bridgeB.dispose();
  });

  it("does not echo local edits back as remote changes", () => {
    const store = createStore();
    const doc = new Y.Doc();
    const bridge = attachBoardBridge(store, doc);
    const remote: string[] = [];
    store.listen((entry) => remote.push(...Object.keys(entry.changes.added)), { source: "remote", scope: "document" });
    store.put([makeGeoShape("no-echo")]);
    expect(remote).toEqual([]);
    bridge.dispose();
  });
});

describe("createBoardStore", () => {
  it("loads valid .tldr content and falls back to an empty store", () => {
    const source = createStore();
    source.put([makeGeoShape("loaded")]);
    const store = createBoardStore(serializeBoard(source.allRecords()));
    expect(store.get(createShapeId("loaded"))).toBeDefined();

    const fresh = createBoardStore("");
    expect(fresh.allRecords().some((record) => record.typeName === "shape")).toBe(false);

    const garbage = createBoardStore("{oops");
    expect(garbage.allRecords().some((record) => record.typeName === "shape")).toBe(false);
  });
});

describe("attachBoardPresence", () => {
  const alice = { id: "alice", name: "Alice", color: "#e03131" };
  const bob = { id: "bob", name: "Bob", color: "#1971c2" };

  it("publishes local presence to awareness and renders remote peers in the store", () => {
    const storeA = createStore();
    const storeB = createStore();
    const awarenessA = new Awareness(new Y.Doc());
    const awarenessB = new Awareness(new Y.Doc());
    const disposeA = attachBoardPresence(storeA, awarenessA, alice, { throttleMs: 0 });
    const disposeB = attachBoardPresence(storeB, awarenessB, bob, { throttleMs: 0 });

    const local = awarenessA.getLocalState()?.boardPresence as TLInstancePresence | undefined;
    expect(local).toBeDefined();
    expect(local!.userName).toBe("Alice");
    expect(local!.color).toBe("#e03131");
    expect(local!.id.startsWith("instance_presence:")).toBe(true);

    syncAwareness(awarenessA, awarenessB);
    const seenByB = presenceRecords(storeB);
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]).toMatchObject({ userName: "Alice", color: "#e03131" });
    // Our own presence is broadcast, not stored locally.
    expect(presenceRecords(storeA).map((record) => record.userName)).toEqual(["Bob"]);

    disposeA();
    disposeB();
    awarenessA.destroy();
    awarenessB.destroy();
  });

  it("reclaims a peer's presence when it leaves or times out", () => {
    const storeA = createStore();
    const storeB = createStore();
    const awarenessA = new Awareness(new Y.Doc());
    const awarenessB = new Awareness(new Y.Doc());
    const disposeA = attachBoardPresence(storeA, awarenessA, alice, { throttleMs: 0 });
    const disposeB = attachBoardPresence(storeB, awarenessB, bob, { throttleMs: 0 });
    syncAwareness(awarenessA, awarenessB);
    expect(presenceRecords(storeB)).toHaveLength(1);

    // Graceful leave: A clears its field (dispose) and the update propagates.
    disposeA();
    syncAwareness(awarenessA, awarenessB);
    expect(presenceRecords(storeB)).toHaveLength(0);

    // Timeout path: B never hears from A again; the client drops out of states.
    const disposeA2 = attachBoardPresence(storeA, awarenessA, alice, { throttleMs: 0 });
    syncAwareness(awarenessA, awarenessB);
    expect(presenceRecords(storeB)).toHaveLength(1);
    removeAwarenessStates(awarenessB, [awarenessA.clientID], "test");
    expect(presenceRecords(storeB)).toHaveLength(0);

    disposeA2();
    disposeB();
    awarenessA.destroy();
    awarenessB.destroy();
  });

  it("keeps presence out of the Y.Doc records map", () => {
    const storeA = createStore();
    const docA = new Y.Doc();
    const awarenessA = new Awareness(new Y.Doc());
    const bridge = attachBoardBridge(storeA, docA);
    const dispose = attachBoardPresence(storeA, awarenessA, alice, { throttleMs: 0 });
    expect(awarenessA.getLocalState()?.boardPresence).toBeDefined();
    for (const key of docA.getMap(BOARD_RECORDS_KEY).keys()) {
      expect(key.startsWith("instance_presence:")).toBe(false);
    }
    dispose();
    bridge.dispose();
    awarenessA.destroy();
  });

  it("tracks cursor movement through the published record", () => {
    const storeA = createStore();
    const awarenessA = new Awareness(new Y.Doc());
    const dispose = attachBoardPresence(storeA, awarenessA, alice, { throttleMs: 0 });
    const before = awarenessA.getLocalState()?.boardPresence as TLInstancePresence;
    const pointer = storeA.get("pointer:pointer" as TLRecord["id"])! as { x: number; y: number } & TLRecord;
    storeA.put([{ ...pointer, x: 42, y: 24 } as TLRecord]);
    const after = awarenessA.getLocalState()?.boardPresence as TLInstancePresence;
    expect(after.cursor).toMatchObject({ x: 42, y: 24 });
    expect(after.id).toBe(before.id);
    dispose();
    awarenessA.destroy();
  });
});
