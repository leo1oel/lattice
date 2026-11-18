import { describe, expect, it, vi } from "vitest";
import { restoreElements } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import tutorialBoard from "../../../src-tauri/templates/tutorial/attention-map.excalidraw?raw";
import { excalidrawLangCode, fittedView, mergeExternalElements, parseBoardScene, savedVersions, serializeBoardScene } from "./board-store";

// Excalidraw probes canvas filter support at import time, and the shared jsdom
// setup returns no 2D context at all; give it one that answers the probe.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true, writable: true, value: () => ({ filter: "none" }),
  });
});

function rect(id: string, version: number, x = 0, isDeleted = false): OrderedExcalidrawElement {
  const [element] = restoreElements([{
    type: "rectangle", id, x, y: 0, width: 10, height: 10, version, versionNonce: version, isDeleted,
  } as never], null);
  return element;
}

const appState = {} as AppState;
const byId = (elements: readonly OrderedExcalidrawElement[]) => Object.fromEntries(
  elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]),
);

describe("parseBoardScene", () => {
  it("reads the tutorial's converted board", () => {
    const scene = parseBoardScene(tutorialBoard)!;
    const ids = scene.elements.map((element) => element.id);
    expect(ids).toEqual(expect.arrayContaining(["query", "scores", "softmax", "weighted", "context", "context-label"]));
    expect(scene.grid).toEqual({ gridSize: 20, gridStep: 5, gridModeEnabled: false });
  });

  it("treats an empty file as an empty board and refuses what is not a scene", () => {
    expect(parseBoardScene("  ")).toEqual({ elements: [], files: {}, grid: { gridSize: 20, gridStep: 5, gridModeEnabled: false } });
    expect(parseBoardScene("{")).toBeNull();
    expect(parseBoardScene("{\"tldrawFileFormatVersion\":1,\"records\":[]}")).toBeNull();
  });
});

describe("serializeBoardScene", () => {
  it("writes the elements without deleted ones, and none of the per-user view", () => {
    const json = serializeBoardScene(
      [rect("kept", 2), rect("gone", 3, 0, true)],
      { scrollX: 400, scrollY: -20, zoom: { value: 2 }, gridSize: 20, viewBackgroundColor: "transparent" } as never,
      {},
    );
    const saved = JSON.parse(json);
    expect(saved).toMatchObject({ type: "excalidraw", version: 2, source: "lattice" });
    expect(saved.elements.map((element: { id: string }) => element.id)).toEqual(["kept"]);
    expect(saved.appState).toEqual({ gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" });
    expect(parseBoardScene(json)!.elements.map((element) => element.id)).toEqual(["kept"]);
  });
});

describe("fittedView", () => {
  it("centres the content, zooming out to fit but never in past 100%", () => {
    const wide = fittedView([rect("a", 1, 0), rect("b", 1, 990)], 500, 300);
    expect(wide.zoom).toBeCloseTo(0.45);
    expect(wide.scrollX).toBeCloseTo(500 / 0.9 - 500);
    expect(wide.scrollY).toBeCloseTo(300 / 0.9 - 5);
    expect(fittedView([rect("a", 1, 0)], 500, 300)).toEqual({ scrollX: 245, scrollY: 145, zoom: 1 });
  });
});

describe("excalidrawLangCode", () => {
  it("passes Lattice's locales through and falls back to English", () => {
    expect(["en", "zh-CN", "xx"].map(excalidrawLangCode)).toEqual(["en", "zh-CN", "en"]);
  });
});

describe("mergeExternalElements", () => {
  it("takes the file's copy of every element unchanged here, even an older one", () => {
    const local = [rect("a", 5, 0), rect("b", 5, 0)];
    const merged = byId(mergeExternalElements(local, [rect("a", 2, 100), rect("b", 9, 200)], savedVersions(local), appState));
    expect(merged.a.x).toBe(100);
    expect(merged.b.x).toBe(200);
  });

  it("keeps an unsaved edit over an older copy in the file, and a new unsaved element", () => {
    const saved = savedVersions([rect("a", 5)]);
    const local = [rect("a", 6, 50), rect("fresh", 1, 10)];
    const merged = byId(mergeExternalElements(local, [rect("a", 5, 100)], saved, appState));
    expect(merged.a.x).toBe(50);
    expect(merged.fresh.x).toBe(10);
  });

  it("drops what the file no longer has and adds what it gained", () => {
    const local = [rect("a", 1), rect("b", 1)];
    const merged = byId(mergeExternalElements(local, [rect("a", 1), rect("c", 1, 30)], savedVersions(local), appState));
    expect(Object.keys(merged).sort()).toEqual(["a", "c"]);
  });
});
