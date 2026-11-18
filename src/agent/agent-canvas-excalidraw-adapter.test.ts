import { describe, expect, it, vi } from "vitest";
import { setCustomTextMetricsProvider } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createExcalidrawAgentCanvasAdapter } from "./agent-canvas-excalidraw-adapter";

// Excalidraw probes canvas filter support at import time and registers its
// fonts as it measures text; jsdom has neither a 2D context nor FontFace.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true, writable: true, value: () => ({ filter: "none" }),
  });
  globalThis.FontFace ??= class {
    status = "loaded";
    constructor(readonly family: string) {}
    load() { return Promise.resolve(this); }
  } as unknown as typeof FontFace;
});
// jsdom cannot measure text: every character is 10 px wide.
setCustomTextMetricsProvider({ getLineWidth: (text) => text.length * 10 });

type Shape = Record<string, unknown> & { id: string };

function board(canWrite = true) {
  let elements: ExcalidrawElement[] = [];
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    updateScene: vi.fn((scene: { elements: ExcalidrawElement[] }) => { elements = scene.elements; }),
  };
  const adapter = createExcalidrawAgentCanvasAdapter(api as unknown as ExcalidrawImperativeAPI, () => canWrite);
  const run = (action: "list" | "create" | "update" | "delete", args: Record<string, unknown>) => adapter.execute(action, args);
  const shapes = (action: "create" | "update", list: Record<string, unknown>[]) => (run(action, { shapes: list }) as { shapes: Shape[] }).shapes;
  const live = () => elements.filter((element) => !element.isDeleted);
  return { api, run, shapes, live, element: (id: string) => elements.find((element) => element.id === id)! };
}

describe("the Excalidraw canvas adapter", () => {
  it("creates, lists, updates and deletes shapes in the tldraw-era wire format", () => {
    const { run, shapes, live, element } = board();
    const [box] = shapes("create", [{ id: "shape:box", type: "rectangle", x: 10, y: 20, width: 200, height: 80, text: "Result" }]);
    expect(box).toMatchObject({ id: "shape:box", type: "rectangle", x: 10, y: 20, width: 200, height: 80, text: "Result", fill: "none", isLocked: false, opacity: 1 });
    const labelId = element("box").boundElements![0].id;
    expect(element(labelId)).toMatchObject({ type: "text", containerId: "box", text: "Result" });
    expect(run("list", {})).toMatchObject({ shapes: [{ id: "shape:box" }], total: 1, hasMore: false });

    const offset = element(labelId).x - element("box").x;
    const [moved] = shapes("update", [{ id: "shape:box", x: 40, color: "blue", fill: "solid" }]);
    expect(moved).toMatchObject({ x: 40, color: "#1971c2", backgroundColor: "#a5d8ff", fill: "solid", text: "Result" });
    expect(element(labelId).x).toBe(40 + offset);

    const [relabelled] = shapes("update", [{ id: "shape:box", text: "Context" }]);
    expect(relabelled.text).toBe("Context");
    expect(element(labelId).isDeleted).toBe(true);

    expect(run("delete", { ids: ["shape:box"] })).toEqual({ deletedIds: ["shape:box"] });
    expect(live()).toEqual([]);
    expect(run("list", {})).toMatchObject({ shapes: [], total: 0 });
  });

  it("makes notes, text, lines, strokes, highlights and frames, and keeps one undo step per call", () => {
    const { api, shapes, element } = board();
    const made = shapes("create", [
      { id: "shape:note", type: "sticky", x: 0, y: 0, text: "Idea" },
      { id: "shape:title", type: "text", x: 0, y: 300, text: "Title" },
      { id: "shape:rule", type: "line", x: 0, y: 400, width: 300 },
      { id: "shape:scribble", type: "draw", x: 0, y: 500, points: [[0, 0], [10, 5], [20, 0]] },
      { id: "shape:mark", type: "highlight", x: 0, y: 600, points: [[0, 0], [50, 0]], color: "green" },
      { id: "shape:area", type: "frame", x: 500, y: 0, text: "Section" },
    ]);
    expect(made.map((shape) => shape.type)).toEqual(["note", "text", "line", "draw", "highlight", "frame"]);
    expect(made[0]).toMatchObject({ width: 200, height: 200, backgroundColor: "#ffec99", text: "Idea" });
    expect(made[1]).toMatchObject({ text: "Title", width: 50 });
    expect(made[2].points).toEqual([[0, 0], [300, 0]]);
    expect(made[4]).toMatchObject({ color: "#69db7c", opacity: 0.5 });
    expect(made[5]).toMatchObject({ text: "Section", width: 400, height: 300 });
    expect(element("rule")).toMatchObject({ roughness: 0, strokeWidth: 2 });
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(api.updateScene.mock.calls[0][0]).toMatchObject({ captureUpdate: "IMMEDIATELY" });

    const [title] = shapes("update", [{ id: "shape:title", text: "A longer title", frameId: "shape:area" }]);
    expect(title).toMatchObject({ text: "A longer title", width: 140, frameId: "shape:area" });
  });

  it("binds an arrow's ends to shapes, and unbinds them when a shape goes", () => {
    const { run, shapes, element } = board();
    shapes("create", [{ id: "shape:a", type: "ellipse" }, { id: "shape:b", type: "diamond", x: 400 }]);
    const [arrow] = shapes("create", [{ id: "shape:link", type: "arrow", x: 160, y: 50, points: [[0, 0], [240, 0]], startBinding: "shape:a", endBinding: "shape:b", text: "uses" }]);
    expect(arrow).toMatchObject({ startBinding: "shape:a", endBinding: "shape:b", text: "uses" });
    expect(element("b").boundElements).toEqual([{ id: "link", type: "arrow" }]);
    shapes("update", [{ id: "shape:link", endBinding: null }]);
    expect(element("b").boundElements).toEqual([]);
    expect(element("link")).toMatchObject({ endBinding: null });
    run("delete", { ids: ["shape:a"] });
    expect(element("link")).toMatchObject({ startBinding: null, isDeleted: false });
  });

  it("refuses what the contract refuses", () => {
    const { run, shapes } = board();
    shapes("create", [{ id: "shape:pinned", type: "rectangle", isLocked: true }, { id: "shape:rule", type: "line" }]);
    const fails = (action: "create" | "update" | "delete", args: Record<string, unknown>) => () => run(action, args);
    expect(fails("create", { shapes: [{ type: "cloud" }] })).toThrow("Unsupported canvas shape type: cloud");
    expect(fails("create", { shapes: [{ type: "rectangle", id: "box" }] })).toThrow(/shape:<letters/);
    expect(fails("create", { shapes: [{ type: "rectangle", id: "shape:pinned" }] })).toThrow("Canvas shape already exists: shape:pinned");
    expect(fails("create", { shapes: [{ type: "rectangle", color: "teal" }] })).toThrow("Unsupported canvas color.");
    expect(fails("create", { shapes: [{ type: "draw" }] })).toThrow(/points must hold/);
    expect(fails("update", { shapes: [{ id: "shape:pinned", x: 1 }] })).toThrow("Canvas shape is locked: shape:pinned");
    expect(fails("update", { shapes: [{ id: "shape:gone", x: 1 }] })).toThrow("Canvas shape not found: shape:gone");
    expect(fails("update", { shapes: [{ id: "shape:rule", text: "no" }] })).toThrow("The line shape type does not accept text.");
    expect(fails("update", { shapes: [{ id: "shape:rule", startBinding: "shape:pinned" }] })).toThrow("Only arrows bind to shapes.");
    expect(fails("update", { shapes: [{ id: "shape:rule", frameId: "shape:pinned" }] })).toThrow("Not a frame: shape:pinned");
    expect(fails("delete", { ids: ["shape:pinned"] })).toThrow("Canvas shape is locked: shape:pinned");
    const unsafe = JSON.parse('{"shapes":[{"type":"note","props":{"__proto__":{"polluted":true}}}]}');
    expect(fails("create", unsafe)).toThrow("Raw canvas props are not supported.");
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
    expect(() => board(false).run("create", { shapes: [{ type: "note" }] })).toThrow(/read-only/);
  });
});
