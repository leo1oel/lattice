import { describe, expect, it } from "vitest";
import {
  executeAgentCanvasToolRequest,
  parseAgentCanvasToolRequest,
  registerAgentCanvasAdapter,
  SYNARA_CANVAS_TOOL_REQUEST,
  waitForAgentCanvasAdapter,
} from "./agent-canvas-tools";

function listRequest(id: string) {
  return parseAgentCanvasToolRequest({
    type: SYNARA_CANVAS_TOOL_REQUEST, version: 1, id, action: "list", args: {}, expiresAt: Date.now() + 1_000,
  });
}

describe("agent canvas tools", () => {
  it("keeps a newer board registered when an older board unmounts, and reports when no canvas is open", async () => {
    const unregisterOld = registerAgentCanvasAdapter("old.excalidraw", { execute: () => ({ board: "old" }) });
    const unregisterCurrent = registerAgentCanvasAdapter("current.excalidraw", { execute: () => ({ board: "current" }) });
    unregisterOld();
    await expect(executeAgentCanvasToolRequest(listRequest("request-current")!)).resolves.toMatchObject({
      ok: true,
      result: { board: "current" },
    });
    unregisterCurrent();
    // The correlated protocol parses, and its id comes back on the failure.
    const request = listRequest("request-1");
    expect(request).not.toBeNull();
    await expect(executeAgentCanvasToolRequest(request!)).resolves.toMatchObject({
      id: "request-1",
      ok: false,
      error: { code: "canvas_not_open" },
    });
  });

  it("waits for the requested board rather than accepting a different active canvas", async () => {
    const unregisterOld = registerAgentCanvasAdapter("old.excalidraw", { execute: () => ({}) });
    let settled = false;
    const waiting = waitForAgentCanvasAdapter("new.excalidraw", 1_000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const unregisterNew = registerAgentCanvasAdapter("new.excalidraw", { execute: () => ({}) });
    await waiting;
    expect(settled).toBe(true);
    unregisterOld();
    unregisterNew();
  });
});
