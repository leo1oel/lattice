import { describe, expect, it } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { createTldrawAgentCanvasAdapter } from "./agent-canvas-tldraw-adapter";
import {
  executeAgentCanvasToolRequest,
  parseAgentCanvasToolRequest,
  registerAgentCanvasAdapter,
  SYNARA_CANVAS_TOOL_REQUEST,
} from "./agent-canvas-tools";

function fakeEditor() {
  const shapes = new Map<TLShapeId, TLShape>();
  const editor = {
    getCurrentPageShapes: () => [...shapes.values()],
    getShape: (id: TLShapeId) => shapes.get(id),
    createShapes: (partials: Array<Record<string, unknown>>) => {
      for (const partial of partials) shapes.set(partial.id as TLShapeId, {
        x: 0, y: 0, rotation: 0, opacity: 1, isLocked: false,
        parentId: "page:page", index: "a1", meta: {}, props: {},
        ...partial,
        typeName: "shape",
      } as unknown as TLShape);
    },
    updateShapes: (partials: Array<Record<string, unknown>>) => {
      for (const partial of partials) {
        const current = shapes.get(partial.id as TLShapeId)!;
        shapes.set(current.id, {
          ...current,
          ...partial,
          props: { ...current.props, ...(partial.props as object | undefined) },
        } as TLShape);
      }
    },
    deleteShapes: (ids: TLShapeId[]) => ids.forEach((id) => shapes.delete(id)),
    isShapeOrAncestorLocked: (shape: TLShape) => shape.isLocked,
  } as unknown as Editor;
  return { editor, shapes };
}

describe("agent canvas tools", () => {
  it("creates, lists, updates, and deletes model-friendly shapes", () => {
    const { editor } = fakeEditor();
    const adapter = createTldrawAgentCanvasAdapter(editor, () => true);
    const created = adapter.execute("create", {
      shapes: [{ id: "shape:box", type: "rectangle", x: 10, y: 20, width: 200, height: 80, text: "Result" }],
    }) as { shapes: TLShape[] };
    expect(created.shapes[0]).toMatchObject({
      id: "shape:box", type: "geo", x: 10, y: 20,
      props: { geo: "rectangle", w: 200, h: 80 },
    });

    const updated = adapter.execute("update", {
      shapes: [{ id: "shape:box", x: 40, color: "blue" }],
    }) as { shapes: TLShape[] };
    expect(updated.shapes[0]).toMatchObject({ x: 40, props: { color: "blue", geo: "rectangle" } });
    expect(adapter.execute("list", {})).toMatchObject({ shapes: [{ id: "shape:box" }] });
    expect(adapter.execute("delete", { ids: ["shape:box"] })).toEqual({ deletedIds: ["shape:box"] });
    expect(adapter.execute("list", {})).toMatchObject({ shapes: [], hasMore: false, total: 0 });
  });

  it("rejects writes to a read-only canvas and unsafe properties", () => {
    const { editor } = fakeEditor();
    const readonly = createTldrawAgentCanvasAdapter(editor, () => false);
    expect(() => readonly.execute("create", { shapes: [{ type: "note" }] })).toThrow(/read-only/);
    const writable = createTldrawAgentCanvasAdapter(editor, () => true);
    const unsafe = JSON.parse('{"shapes":[{"type":"note","props":{"__proto__":{"polluted":true}}}]}');
    expect(() => writable.execute("create", unsafe)).toThrow(/Raw canvas props are not supported/);
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps a newer board registered when an older board unmounts", async () => {
    const unregisterOld = registerAgentCanvasAdapter({ execute: () => ({ board: "old" }) });
    const unregisterCurrent = registerAgentCanvasAdapter({ execute: () => ({ board: "current" }) });
    unregisterOld();
    const request = parseAgentCanvasToolRequest({
      type: SYNARA_CANVAS_TOOL_REQUEST,
      version: 1,
      id: "request-current",
      action: "list",
      args: {},
      expiresAt: Date.now() + 1_000,
    })!;
    await expect(executeAgentCanvasToolRequest(request)).resolves.toMatchObject({
      ok: true,
      result: { board: "current" },
    });
    unregisterCurrent();
  });

  it("parses the correlated protocol and reports when no canvas is open", async () => {
    const request = parseAgentCanvasToolRequest({
      type: SYNARA_CANVAS_TOOL_REQUEST,
      version: 1,
      id: "request-1",
      action: "list",
      args: {},
      expiresAt: Date.now() + 1_000,
    });
    expect(request).not.toBeNull();
    const unregister = registerAgentCanvasAdapter({ execute: () => ({ shapes: [] }) });
    unregister();
    await expect(executeAgentCanvasToolRequest(request!)).resolves.toMatchObject({
      id: "request-1",
      ok: false,
      error: { code: "canvas_not_open" },
    });
  });
});
