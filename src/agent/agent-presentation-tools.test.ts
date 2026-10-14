import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeAgentPresentationToolRequest,
  SYNARA_PRESENTATION_TOOL_REQUEST,
  type AgentPresentationToolRequest,
} from "./agent-presentation-tools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const request = (): AgentPresentationToolRequest => ({
  type: SYNARA_PRESENTATION_TOOL_REQUEST,
  version: 1,
  id: "preview-1",
  action: "preview_page",
  args: { deck: "yiming-scholarship", page: 1 },
  expiresAt: Date.now() + 60_000,
});

describe("agent presentation preview", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockImplementation(async (command) => (
      command === "presentation_ensure_ready"
        ? {
            state: "ready",
            origin: "http://127.0.0.1:4100",
            sessionUrl: "http://127.0.0.1:4100/__lattice/bootstrap?token=session",
            controlToken: "control",
            leaseId: "lease-1",
          }
        : undefined
    ));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the deck's build errors instead of rendering a deck that cannot load", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      errors: [{
        file: "slides/yiming-scholarship/index.tsx",
        line: 3,
        column: 26,
        message: 'Failed to resolve import "./assets/clip-embedding.png" from "slides/yiming-scholarship/index.tsx". Does the file exist?',
        frame: '3 | import clipEmbedding from "./assets/clip-embedding.png";',
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeAgentPresentationToolRequest(request(), "/projects/personal");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4100/__lattice/build-errors/yiming-scholarship"),
      { headers: { authorization: "Bearer control" } },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("presentation_build_failed");
    expect(result.error?.message).toContain(
      'slides/yiming-scholarship/index.tsx:3:26: Failed to resolve import "./assets/clip-embedding.png"',
    );
    expect(result.error?.message).toContain('3 | import clipEmbedding from "./assets/clip-embedding.png";');
    // The runtime refreshed from disk before the check, and the lease is returned.
    expect(invoke).toHaveBeenCalledWith("presentation_refresh_native_workspace", { projectRoot: "/projects/personal" });
    expect(invoke).toHaveBeenCalledWith("presentation_release", { projectRoot: "/projects/personal", leaseId: "lease-1" });
    expect(document.querySelector("iframe")).toBeNull();
  });
});
