import { describe, expect, it } from "vitest";
import { createShapeId, toRichText, type TLCamera, type TLRecord, type TLShape } from "tldraw";
import { createBoardStore, mergeExternalBoardSource, parseBoardRecords, pruneUnusedAssets, serializeBoard } from "./board-store";
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
