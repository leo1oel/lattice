import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmAction } from "../app-utils";
import { showError } from "../app/notify";
import { onBibliographyWrite } from "../project/project-files-changed";
import {
  executeAgentBibliographyToolRequest,
  parseAgentBibliographyToolRequest,
} from "./agent-bibliography-tools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../app/notify", () => ({ showError: vi.fn() }));
vi.mock("../app-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-utils")>(),
  confirmAction: vi.fn(),
}));

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
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(confirmAction).mockReset();
    vi.mocked(showError).mockReset();
  });

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

    await expect(executeAgentBibliographyToolRequest(request, () => "/workspace/paper")).resolves
      .toMatchObject({ ok: true, result: { citationKey: "vaswani2017attention" } });
    expect(invoke).toHaveBeenCalledWith("agent_bibliography_mutation", {
      projectRoot: "/workspace/paper",
      mutation: { action: "cite", query: "Attention Is All You Need" },
    });
  });

  it("rejects stale projects and expired requests before native execution", async () => {
    await expect(executeAgentBibliographyToolRequest(request, () => "/workspace/other")).resolves
      .toMatchObject({ ok: false, error: { code: "bibliography_project_changed" } });
    await expect(executeAgentBibliographyToolRequest(
      { ...request, expiresAt: Date.now() - 1 },
      () => "/workspace/paper",
    )).resolves.toMatchObject({ ok: false, error: { code: "bibliography_tool_expired" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  describe("remove_reference", () => {
    const removal = { ...request, id: "bib-request-2", action: "remove_reference" as const, params: { key: "teoh2025nextlatent" } };
    /** Answers the preview with `blockers`, and the removal itself with `removed`. */
    const host = (blockers: { path: string; line: number }[] = [], removed = true) => vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "remove_reference") throw new Error(`unexpected ${command}`);
      const { key, citationMode } = args as { key: string; citationMode?: string };
      const preview = citationMode === "preview";
      return { key, removed: !preview && removed, blockers: preview ? blockers : [] };
    });
    const removeCalls = () => vi.mocked(invoke).mock.calls.filter(([, args]) => !(args as { citationMode?: string }).citationMode);

    it("never deletes on the agent's word: it answers at once and asks the writer", async () => {
      host();
      let answer: (value: boolean) => void = () => {};
      vi.mocked(confirmAction).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

      const response = await executeAgentBibliographyToolRequest(removal, () => "/workspace/paper");
      expect(response).toMatchObject({
        ok: true,
        result: { key: "teoh2025nextlatent", removed: false, awaitingUserConfirmation: true },
      });
      expect(String(response.result?.note)).toContain("Do not report the entry as removed");
      expect(invoke).not.toHaveBeenCalledWith("agent_bibliography_mutation", expect.anything());
      expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ cancelLabel: "Keep entry", destructive: true }));

      // Keep entry: nothing is removed.
      answer(false);
      await vi.waitFor(() => expect(vi.mocked(confirmAction).mock.results[0]?.value).resolves.toBe(false));
      expect(removeCalls()).toEqual([]);
    });

    it("removes the entry, with History, only when the writer confirms", async () => {
      host();
      vi.mocked(confirmAction).mockResolvedValue(true);
      const writes = vi.fn();
      const stop = onBibliographyWrite("/workspace/paper", writes);

      await executeAgentBibliographyToolRequest(removal, () => "/workspace/paper");
      await vi.waitFor(() => expect(writes).toHaveBeenCalledOnce());
      // No citationMode: Block mode, so a citation written meanwhile keeps the entry.
      expect(removeCalls()).toEqual([["remove_reference", { key: "teoh2025nextlatent", projectRoot: "/workspace/paper" }]]);
      stop();
    });

    it("keeps a cited entry without asking, and asks once for a repeated request", async () => {
      host([{ path: "main.tex", line: 84 }]);
      await expect(executeAgentBibliographyToolRequest(removal, () => "/workspace/paper")).resolves
        .toMatchObject({ ok: true, result: { removed: false, blockers: [{ path: "main.tex", line: 84 }] } });
      expect(confirmAction).not.toHaveBeenCalled();

      host();
      vi.mocked(confirmAction).mockImplementation(() => new Promise(() => {}));
      const repeated = { ...removal, params: { key: "asked2024once" } };
      await executeAgentBibliographyToolRequest(repeated, () => "/workspace/paper");
      await executeAgentBibliographyToolRequest(repeated, () => "/workspace/paper");
      expect(confirmAction).toHaveBeenCalledOnce();
    });

    it("abandons a confirmed removal once the window shows another project", async () => {
      host();
      let root = "/workspace/paper";
      let answer: (value: boolean) => void = () => {};
      vi.mocked(confirmAction).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      await executeAgentBibliographyToolRequest({ ...removal, params: { key: "other2024" } }, () => root);
      root = "/workspace/other";
      answer(true);
      await vi.waitFor(() => expect(vi.mocked(confirmAction).mock.results[0]?.value).resolves.toBe(true));
      await Promise.resolve();
      expect(removeCalls()).toEqual([]);
    });
  });
});
