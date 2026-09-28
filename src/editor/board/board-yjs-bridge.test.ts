import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  createShapeId,
  toRichText,
  type TLCamera,
  type TLInstancePresence,
  type TLPage,
  type TLRecord,
  type TLShape,
  type TLStore,
} from "tldraw";
import {
  BOARD_CONTENT_KEY,
  BOARD_RECORD_GENERATIONS_KEY,
  BOARD_RECORD_PATCHES_KEY,
  BOARD_RECORDS_KEY,
  attachBoardBridge,
  attachBoardPresence,
  boardDocContent,
  createBoardStore,
  mergeExternalBoardSource,
  parseBoardRecords,
  pruneUnusedAssets,
  replaceBoardDocFromSource,
  seedBoardRecords,
  serializeBoard,
} from "./board-yjs-bridge";
import tutorialBoard from "../../../src-tauri/templates/tutorial/attention-map.tldr?raw";

const createStore = () => createBoardStore("");

function makeGeoShape(id: string, x = 0): TLShape {
  return {
    id: createShapeId(id), typeName: "shape", type: "geo", x, y: 0, rotation: 0, index: "a1",
    parentId: "page:page", isLocked: false, opacity: 1, meta: {},
    props: {
      geo: "rectangle", dash: "draw", url: "", w: 100, h: 100, growY: 0, scale: 1, labelColor: "black",
      color: "black", fill: "none", size: "m", font: "draw", align: "middle", verticalAlign: "middle",
      richText: toRichText(""),
    },
  } as TLShape;
}

const makeCamera = () => ({ id: "camera:page:page", typeName: "camera", x: 1, y: 2, z: 3, meta: {} } as TLCamera);

/** .tldr text for a default board holding `shapes`. */
function boardSource(...shapes: TLShape[]): string {
  const store = createStore();
  store.put(shapes);
  return serializeBoard(store.allRecords());
}

/** A Y.Doc as a fresh import leaves it: only the raw .tldr "content". */
function importedDoc(...shapes: TLShape[]): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(BOARD_CONTENT_KEY).insert(0, boardSource(...shapes));
  return doc;
}

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function syncAwareness(a: Awareness, b: Awareness) {
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), "test");
  applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [b.clientID]), "test");
}

const presenceRecords = (store: TLStore) =>
  store.allRecords().filter((record): record is TLInstancePresence => record.typeName === "instance_presence");

// Bridges and presence bindings are disposed after each test.
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function bridged(doc = new Y.Doc(), options?: Parameters<typeof attachBoardBridge>[2]) {
  const store = createStore();
  disposers.push(attachBoardBridge(store, doc, options));
  return { store, doc };
}

/** Two bridged peers, optionally starting from the same initial doc update. */
function peers(initial?: Uint8Array) {
  const docs = [new Y.Doc(), new Y.Doc()];
  if (initial) for (const doc of docs) Y.applyUpdate(doc, initial);
  const [a, b] = docs.map((doc) => bridged(doc));
  return { a: a.store, b: b.store, sync: () => syncDocs(a.doc, b.doc) };
}

const shapeIn = (store: TLStore, id: TLShape["id"]) => store.get(id) as TLShape;

describe("serialize/parse round-trip", () => {
  it("loads the editable attention diagram bundled with the tutorial", () => {
    const shapes = parseBoardRecords(tutorialBoard)!.filter((record) => record.typeName === "shape");
    expect(shapes).toHaveLength(16);
    expect(shapes.map((shape) => shape.id)).toEqual(expect.arrayContaining(
      ["query", "scores", "softmax", "weighted", "context"].map((id) => createShapeId(id)),
    ));
  });

  it("round-trips document records through .tldr JSON", () => {
    const store = createStore();
    const shape = makeGeoShape("one");
    store.put([shape, makeCamera()]);
    const json = serializeBoard(store.allRecords());
    const ids = parseBoardRecords(json)!.map((record) => record.id);
    expect(ids).toEqual(expect.arrayContaining([shape.id, "page:page", "document:document"]));
    // Ephemeral records never reach the file format.
    expect(ids).not.toContain("camera:page:page");
    expect(JSON.parse(json).tldrawFileFormatVersion).toBe(1);
  });

  it("produces byte-stable output independent of input order", () => {
    const records = createStore().allRecords();
    expect(serializeBoard([...records].reverse())).toBe(serializeBoard(records));
  });

  it.each(["not json", "", "{}"])("returns null for invalid input %j", (input) => {
    expect(parseBoardRecords(input)).toBeNull();
  });

  it("drops unreferenced assets and keeps referenced ones", () => {
    const asset = (id: string) => ({
      id: `asset:${id}`,
      typeName: "asset",
      type: "image",
      meta: {},
      props: { w: 10, h: 10, name: "a.png", isAnimated: false, mimeType: "image/png", src: "assets/a.png" },
    } as unknown as TLRecord);
    const used = asset("used");
    const shape = { ...makeGeoShape("img"), props: { ...makeGeoShape("img").props, assetId: used.id } } as TLRecord;
    expect(pruneUnusedAssets([used, asset("orphan"), shape]).map((record) => record.id)).toEqual([used.id, shape.id]);
  });
});

describe("createBoardStore", () => {
  it("loads valid .tldr content and falls back to an empty store", () => {
    expect(createBoardStore(boardSource(makeGeoShape("loaded"))).get(createShapeId("loaded"))).toBeDefined();
    for (const source of ["", "{oops"]) {
      expect(createBoardStore(source).allRecords().some((record) => record.typeName === "shape")).toBe(false);
    }
  });
});

describe("mergeExternalBoardSource", () => {
  it("applies external .tldr text as a remote-authoritative snapshot", () => {
    const store = createStore();
    const stale = makeGeoShape("stale");
    const kept = makeGeoShape("kept", 10);
    store.put([stale, kept]);

    expect(mergeExternalBoardSource(store, boardSource({ ...makeGeoShape("kept"), x: 999 }, makeGeoShape("added")))).toBe(true);
    expect(store.get(stale.id)).toBeUndefined();
    expect(store.get(createShapeId("added"))).toBeDefined();
    expect(store.get(kept.id)).toMatchObject({ x: 999 });
  });

  it("leaves ephemeral records untouched", () => {
    const store = createStore();
    store.put([makeCamera()]);
    mergeExternalBoardSource(store, boardSource());
    expect(store.get(makeCamera().id)).toMatchObject({ x: 1, y: 2 });
  });

  it("rejects invalid or empty input without touching the store", () => {
    const store = createStore();
    const shape = makeGeoShape("untouched");
    store.put([shape]);
    expect(mergeExternalBoardSource(store, "not json")).toBe(false);
    expect(mergeExternalBoardSource(store, "")).toBe(false);
    expect(store.get(shape.id)).toBeDefined();
  });
});

describe("seedBoardRecords", () => {
  it("promotes imported content into the records map exactly once", () => {
    const doc = importedDoc(makeGeoShape("seeded"));
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
    const a = importedDoc(makeGeoShape("shared"));
    const b = importedDoc(makeGeoShape("shared"));
    seedBoardRecords(a);
    seedBoardRecords(b);
    syncDocs(a, b);
    const ids = (doc: Y.Doc) => [...doc.getMap(BOARD_RECORDS_KEY).keys()].sort();
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).toContain(createShapeId("shared"));
  });
});

describe("boardDocContent", () => {
  it("falls back to imported text before seeding and prefers records after", () => {
    const doc = importedDoc(makeGeoShape("first"));
    expect(boardDocContent(doc)).toContain(createShapeId("first"));

    seedBoardRecords(doc);
    // A record-only edit is reflected in the serialized content even though
    // the imported text is now stale.
    doc.getMap<TLRecord>(BOARD_RECORDS_KEY).set(makeGeoShape("second").id, makeGeoShape("second"));
    expect(boardDocContent(doc)).toContain(createShapeId("second"));
    expect(doc.getText(BOARD_CONTENT_KEY).toString()).not.toContain(createShapeId("second"));
  });
});

describe("replaceBoardDocFromSource", () => {
  it("reconciles changed, added, and removed records through the board CRDT", () => {
    const doc = importedDoc(makeGeoShape("kept"), makeGeoShape("removed"));
    seedBoardRecords(doc);
    replaceBoardDocFromSource(doc, boardSource(makeGeoShape("kept", 42), makeGeoShape("added", 7)));

    const records = parseBoardRecords(boardDocContent(doc))!;
    const find = (id: string) => records.find((record) => record.id === createShapeId(id));
    expect(find("kept")).toMatchObject({ x: 42 });
    expect(find("added")).toMatchObject({ x: 7 });
    expect(find("removed")).toBeUndefined();
  });
});

describe("attachBoardBridge", () => {
  it("pushes local document edits into the Y.Doc and keeps ephemeral records local", () => {
    const { store, doc } = bridged();
    const shape = makeGeoShape("local");
    store.put([shape, makeCamera()]);
    const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
    expect(yRecords.get(shape.id)).toMatchObject({ id: shape.id });
    expect(yRecords.has("camera:page:page")).toBe(false);

    store.remove([shape.id]);
    expect(yRecords.has(shape.id)).toBe(false);
  });

  it("mirrors remote edits into the store across two bridged docs", () => {
    const { a, b, sync } = peers();
    const shape = makeGeoShape("remote");
    a.put([shape]);
    sync();
    expect(b.get(shape.id)).toMatchObject({ id: shape.id, type: "geo" });

    a.put([{ ...shape, x: 500 }]);
    sync();
    expect(b.get(shape.id)).toMatchObject({ x: 500 });

    a.remove([shape.id]);
    sync();
    expect(b.get(shape.id)).toBeUndefined();
  });

  /** Concurrent edits to independent fields of `shape` on both peers. */
  function editFieldsConcurrently({ a, b, sync }: ReturnType<typeof peers>, shape: TLShape) {
    a.put([{ ...shapeIn(a, shape.id), x: 500 }]);
    const peerShape = shapeIn(b, shape.id);
    b.put([{ ...peerShape, props: { ...peerShape.props, color: "red" } } as TLShape]);
    sync();
    for (const store of [a, b]) expect(store.get(shape.id)).toMatchObject({ x: 500, props: { color: "red" } });
  }

  it("merges concurrent edits to independent fields of the same shape", () => {
    const pair = peers();
    const shape = makeGeoShape("concurrent");
    pair.a.put([shape]);
    pair.sync();
    editFieldsConcurrently(pair, shape);
  });

  it("preserves concurrent edits when both peers start from a legacy atomic record", () => {
    const shape = makeGeoShape("legacy");
    const baseline = importedDoc(shape);
    baseline.getMap<TLRecord>(BOARD_RECORDS_KEY).set(shape.id, shape);
    editFieldsConcurrently(peers(Y.encodeStateAsUpdate(baseline)), shape);
  });

  it("does not resurrect patches from an older incarnation after delete and recreate", () => {
    const { a, b, sync } = peers();
    const shape = makeGeoShape("recreated");
    a.put([shape]);
    sync();
    a.put([{ ...shapeIn(a, shape.id), x: 900 }]);
    b.remove([shape.id]);
    b.put([{ ...shape, x: 20 }]);
    sync();
    for (const store of [a, b]) expect(store.get(shape.id)).toMatchObject({ x: 20 });
  });

  it("converges when a scalar and its subtree are edited concurrently", () => {
    const { a, b, sync } = peers();
    const shape = { ...makeGeoShape("subtree"), meta: { custom: { child: 1 } } } as TLShape;
    a.put([shape]);
    sync();
    a.put([{ ...shapeIn(a, shape.id), meta: { custom: "scalar" } } as TLShape]);
    b.put([{ ...shapeIn(b, shape.id), meta: { custom: { child: 2, "a/b|c": true } } } as TLShape]);
    sync();
    for (const store of [a, b]) expect(store.get(shape.id)?.meta.custom).toBe("scalar");
  });

  it("rejects prototype-polluting patch paths from peers", () => {
    const { store, doc } = bridged();
    const shape = makeGeoShape("safe-path");
    store.put([shape]);
    const generation = doc.getMap<string>(BOARD_RECORD_GENERATIONS_KEY).get(shape.id)!;

    doc.getMap(BOARD_RECORD_PATCHES_KEY).set(
      `${encodeURIComponent(shape.id)}|${encodeURIComponent(generation)}|meta/__proto__/polluted`,
      true,
    );

    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
    expect(store.get(shape.id)?.meta).toEqual({});
  });

  it("hydrates read-only boards without seeding or publishing local mutations", () => {
    const { store, doc } = bridged(importedDoc(makeGeoShape("visible")), { canWrite: false });
    expect(store.get(createShapeId("visible"))).toBeDefined();
    expect(doc.getMap(BOARD_RECORDS_KEY).size).toBe(0);
    store.put([makeGeoShape("blocked")]);
    expect(doc.getMap(BOARD_RECORDS_KEY).size).toBe(0);
  });

  it("stops publishing immediately when write permission is revoked", () => {
    let canWrite = true;
    const { store, doc } = bridged(new Y.Doc(), { canWrite: () => canWrite });
    store.put([makeGeoShape("published")]);
    expect(doc.getMap(BOARD_RECORDS_KEY).has(createShapeId("published"))).toBe(true);

    canWrite = false;
    store.put([makeGeoShape("blocked-after-revoke")]);
    expect(doc.getMap(BOARD_RECORDS_KEY).has(createShapeId("blocked-after-revoke"))).toBe(false);
  });

  it("seeds an empty store from imported content on attach", () => {
    expect(bridged(importedDoc(makeGeoShape("from-import"))).store.get(createShapeId("from-import"))).toBeDefined();
  });

  it("treats the doc as authoritative on attach, removing stale store records", () => {
    const doc = new Y.Doc();
    const storeA = createStore();
    const disposeA = attachBoardBridge(storeA, doc);
    const kept = makeGeoShape("kept");
    storeA.put([kept]);
    disposeA();

    const storeB = createStore();
    storeB.put([makeGeoShape("stale"), { id: "page:extra", typeName: "page", name: "Extra", index: "a2", meta: {} } as TLPage]);
    disposers.push(attachBoardBridge(storeB, doc));
    expect(storeB.get(kept.id)).toBeDefined();
    expect(storeB.get(createShapeId("stale"))).toBeUndefined();
    expect(storeB.get("page:extra" as TLPage["id"])).toBeUndefined();
  });

  it("does not echo local edits back as remote changes", () => {
    const { store } = bridged();
    const remote: string[] = [];
    store.listen((entry) => remote.push(...Object.keys(entry.changes.added)), { source: "remote", scope: "document" });
    store.put([makeGeoShape("no-echo")]);
    expect(remote).toEqual([]);
  });
});

describe("attachBoardPresence", () => {
  const alice = { id: "alice", name: "Alice", color: "#e03131" };
  const bob = { id: "bob", name: "Bob", color: "#1971c2" };

  /** Presence bindings are idempotent to dispose, so afterEach also releases any a test did not. */
  function present(user: typeof alice, store = createStore(), existing?: Awareness) {
    const awareness = existing ?? new Awareness(new Y.Doc());
    if (!existing) disposers.push(() => awareness.destroy());
    const dispose = attachBoardPresence(store, awareness, user, { throttleMs: 0 });
    disposers.push(dispose);
    return { store, awareness, dispose };
  }

  it("publishes local presence to awareness and renders remote peers in the store", () => {
    const a = present(alice);
    const b = present(bob);
    const local = a.awareness.getLocalState()?.boardPresence as TLInstancePresence;
    expect(local).toMatchObject({ userName: "Alice", color: "#e03131" });
    expect(local.id.startsWith("instance_presence:")).toBe(true);

    syncAwareness(a.awareness, b.awareness);
    expect(presenceRecords(b.store)).toEqual([expect.objectContaining({ userName: "Alice", color: "#e03131" })]);
    // Our own presence is broadcast, not stored locally.
    expect(presenceRecords(a.store).map((record) => record.userName)).toEqual(["Bob"]);
  });

  it("reclaims a peer's presence when it leaves or times out", () => {
    const a = present(alice);
    const b = present(bob);
    syncAwareness(a.awareness, b.awareness);
    expect(presenceRecords(b.store)).toHaveLength(1);

    // Graceful leave: A clears its field (dispose) and the update propagates.
    a.dispose();
    syncAwareness(a.awareness, b.awareness);
    expect(presenceRecords(b.store)).toHaveLength(0);

    // Timeout path: B never hears from A again; the client drops out of states.
    present(alice, a.store, a.awareness);
    syncAwareness(a.awareness, b.awareness);
    expect(presenceRecords(b.store)).toHaveLength(1);
    removeAwarenessStates(b.awareness, [a.awareness.clientID], "test");
    expect(presenceRecords(b.store)).toHaveLength(0);
  });

  it("keeps presence out of the Y.Doc records map", () => {
    const { store, doc } = bridged();
    const { awareness } = present(alice, store);
    expect(awareness.getLocalState()?.boardPresence).toBeDefined();
    for (const key of doc.getMap(BOARD_RECORDS_KEY).keys()) {
      expect(key.startsWith("instance_presence:")).toBe(false);
    }
  });

  it("tracks cursor movement through the published record", () => {
    const { store, awareness } = present(alice);
    const before = awareness.getLocalState()?.boardPresence as TLInstancePresence;
    const pointer = store.get("pointer:pointer" as TLRecord["id"])! as { x: number; y: number } & TLRecord;
    store.put([{ ...pointer, x: 42, y: 24 } as TLRecord]);
    const after = awareness.getLocalState()?.boardPresence as TLInstancePresence;
    expect(after.cursor).toMatchObject({ x: 42, y: 24 });
    expect(after.id).toBe(before.id);
  });
});
