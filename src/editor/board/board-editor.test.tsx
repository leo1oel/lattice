import { describe, expect, it } from "vitest";
import {
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  toRichText,
  type TLCamera,
  type TLShape,
} from "tldraw";
import { mergeExternalBoardSource } from "./board-editor";
import { createBoardStore, serializeBoard } from "./board-yjs-bridge";

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

describe("mergeExternalBoardSource", () => {
  it("applies external .tldr text as a remote-authoritative snapshot", () => {
    const store = createStore();
    const stale = makeGeoShape("stale");
    const kept = makeGeoShape("kept", 10);
    store.put([stale, kept]);

    const external = createStore();
    external.put([{ ...makeGeoShape("kept"), x: 999 }, makeGeoShape("added")]);
    const merged = mergeExternalBoardSource(store, serializeBoard(external.allRecords()));
    expect(merged).toBe(true);

    expect(store.get(stale.id)).toBeUndefined();
    expect(store.get(createShapeId("added"))).toBeDefined();
    expect(store.get(kept.id)).toMatchObject({ x: 999 });
  });

  it("leaves ephemeral records untouched", () => {
    const store = createStore();
    const camera = { id: "camera:page:page", typeName: "camera", x: 7, y: 8, z: 1, meta: {} } as TLCamera;
    store.put([camera]);

    const external = createStore();
    mergeExternalBoardSource(store, serializeBoard(external.allRecords()));
    expect(store.get(camera.id)).toMatchObject({ x: 7, y: 8 });
  });

  it("rejects invalid input without touching the store", () => {
    const store = createStore();
    const shape = makeGeoShape("untouched");
    store.put([shape]);
    expect(mergeExternalBoardSource(store, "not json")).toBe(false);
    expect(mergeExternalBoardSource(store, "")).toBe(false);
    expect(store.get(shape.id)).toBeDefined();
  });

  it("survives an empty board file", () => {
    const store = createBoardStore("");
    expect(mergeExternalBoardSource(store, "")).toBe(false);
  });
});
