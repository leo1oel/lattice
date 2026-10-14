import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeAgentBibliographyToolRequest,
  parseAgentBibliographyToolRequest,
} from "./agent-bibliography-tools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const request = {
  type: "synara:bibliography-tool-request" as const,
  version: 1 as const,
  id: "bib-request-1",
  action: "cite" as const,
  params: { query: "Attention Is All You Need" },
  workspaceRoot: "/workspace/paper",
  // Fixed, not `Date.now() + 10_000`: a clock read at file load expires
  // before a test that runs more than ten seconds later on a loaded runner.
  expiresAt: Date.parse("2999-01-01T00:00:00Z"),
};

describe("agent bibliography host protocol", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("accepts only the three typed bibliography mutations", () => {
    expect(parseAgentBibliographyToolRequest(request)).toEqual(request);
    for (const invalid of [
      { action: "write_file" },
      { params: { query: "paper", path: "references.bib" } },
      { action: "upgrade_bibliography", params: { dryRun: "false" } },
      { action: "remove_reference", params: { key: "" } },
    ]) {
      expect(parseAgentBibliographyToolRequest({ ...request, ...invalid })).toBeNull();
    }
  });

  it("invokes the native broker only for the still-active project", async () => {
    vi.mocked(invoke).mockResolvedValue({
      citationKey: "vaswani2017attention",
      title: "Attention Is All You Need",
    });

    await expect(executeAgentBibliographyToolRequest(request, "/workspace/paper")).resolves
      .toMatchObject({ ok: true, result: { citationKey: "vaswani2017attention" } });
    expect(invoke).toHaveBeenCalledWith("agent_bibliography_mutation", {
      projectRoot: "/workspace/paper",
      mutation: { action: "cite", query: "Attention Is All You Need" },
    });
  });

  it("rejects stale projects and expired requests before native execution", async () => {
    await expect(executeAgentBibliographyToolRequest(request, "/workspace/other")).resolves
      .toMatchObject({ ok: false, error: { code: "bibliography_project_changed" } });
    await expect(executeAgentBibliographyToolRequest(
      { ...request, expiresAt: Date.now() - 1 },
      "/workspace/paper",
    )).resolves.toMatchObject({ ok: false, error: { code: "bibliography_tool_expired" } });
    expect(invoke).not.toHaveBeenCalled();
  });
});
