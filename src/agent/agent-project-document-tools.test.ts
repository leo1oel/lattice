import { describe, expect, it, vi } from "vitest";
import {
  executeAgentProjectDocumentToolRequest,
  parseAgentProjectDocumentToolRequest,
  rejectAgentProjectDocumentToolRequest,
  SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST,
  type AgentProjectDocumentToolRequest,
} from "./agent-project-document-tools";

function request(
  path: string,
  documentType: "board" | "spreadsheet",
): AgentProjectDocumentToolRequest {
  return {
    type: SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST,
    version: 1,
    id: "request-1",
    args: { path, documentType },
    expiresAt: Date.now() + 1_000,
  };
}

describe("agent project document host protocol", () => {
  it("strictly parses normalized board and spreadsheet requests", () => {
    const board = request("figures/model.excalidraw", "board");
    const spreadsheet = request("data/results.lattice-sheet", "spreadsheet");
    expect(parseAgentProjectDocumentToolRequest(board)).toEqual(board);
    expect(parseAgentProjectDocumentToolRequest(spreadsheet)).toEqual(spreadsheet);
    expect(parseAgentProjectDocumentToolRequest({ ...board, version: 2 })).toBeNull();
    expect(parseAgentProjectDocumentToolRequest({ ...board, unexpected: true })).toBeNull();
    expect(parseAgentProjectDocumentToolRequest(request("../model.excalidraw", "board"))).toBeNull();
    expect(parseAgentProjectDocumentToolRequest(request("model.lattice-sheet", "board"))).toBeNull();
    expect(parseAgentProjectDocumentToolRequest(request("model.excalidraw", "spreadsheet"))).toBeNull();
  });

  it("creates a board an older runtime names .tldr as its .excalidraw", () => {
    expect(parseAgentProjectDocumentToolRequest(request("figures/plan.tldr", "board"))?.args)
      .toEqual({ path: "figures/plan.excalidraw", documentType: "board" });
    expect(parseAgentProjectDocumentToolRequest(request("plan.TLDR", "board"))?.args.path).toBe("plan.excalidraw");
    expect(parseAgentProjectDocumentToolRequest(request("plan.tldr", "spreadsheet"))).toBeNull();
  });

  it("answers a request it refuses at once instead of leaving the Agent to time out", async () => {
    await expect(rejectAgentProjectDocumentToolRequest(request("plan.pdf", "board"))).resolves.toMatchObject({
      id: "request-1",
      ok: false,
      error: { code: "project_document_invalid_arguments" },
    });
    expect(rejectAgentProjectDocumentToolRequest({ type: "synara:canvas-tool-request", version: 1, id: "x", expiresAt: 1 })).toBeNull();
  });

  it("creates and reports an opened document through the registered host callback", async () => {
    const createDocument = vi.fn(async (input: AgentProjectDocumentToolRequest) => input.args.path);
    await expect(executeAgentProjectDocumentToolRequest(
      request("results.lattice-sheet", "spreadsheet"),
      createDocument,
    )).resolves.toMatchObject({
      ok: true,
      result: {
        path: "results.lattice-sheet",
        documentType: "spreadsheet",
        opened: true,
      },
    });
    expect(createDocument).toHaveBeenCalledOnce();
  });

  it("rejects expired requests and a missing host without creating anything", async () => {
    const expired = request("model.excalidraw", "board");
    expired.expiresAt = Date.now() - 1;
    const createDocument = vi.fn(async () => "model.excalidraw");
    await expect(executeAgentProjectDocumentToolRequest(expired, createDocument)).resolves.toMatchObject({
      ok: false,
      error: { code: "project_document_tool_expired" },
    });
    expect(createDocument).not.toHaveBeenCalled();
    await expect(executeAgentProjectDocumentToolRequest(
      request("model.excalidraw", "board"),
      null,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "project_document_host_unavailable" },
    });
  });
});
