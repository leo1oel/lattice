import { afterEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  executeAgentSpreadsheetToolRequest,
  parseAgentSpreadsheetToolRequest,
  registerAgentSpreadsheetDocument,
  registerAgentSpreadsheetDocumentResolver,
  SYNARA_SPREADSHEET_TOOL_REQUEST,
  type AgentSpreadsheetToolRequest,
} from "./agent-spreadsheet-tools";
import { applySpreadsheetBatch, readSpreadsheet } from "../editor/spreadsheet/spreadsheet-operations";
import { seedSpreadsheetDoc } from "../editor/spreadsheet/spreadsheet-yjs";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function request(
  action: AgentSpreadsheetToolRequest["action"],
  args: Record<string, unknown>,
): AgentSpreadsheetToolRequest {
  return {
    type: SYNARA_SPREADSHEET_TOOL_REQUEST,
    version: 1,
    id: crypto.randomUUID(),
    action,
    args,
    expiresAt: Date.now() + 10_000,
  };
}

describe("agent spreadsheet host protocol", () => {
  it("strictly parses bounded, versioned request envelopes", () => {
    const valid = request("read", { path: "tables/data.lattice-sheet", range: "A1" });
    expect(parseAgentSpreadsheetToolRequest(valid)).toEqual(valid);
    expect(parseAgentSpreadsheetToolRequest({ ...valid, version: 2 })).toBeNull();
    expect(parseAgentSpreadsheetToolRequest({ ...valid, unexpected: true })).toBeNull();
    expect(parseAgentSpreadsheetToolRequest({ ...valid, action: "command" })).toBeNull();
    expect(parseAgentSpreadsheetToolRequest({
      ...valid,
      args: { value: "界".repeat(100_000) },
    })).toBeNull();
  });

  it("applies one semantic batch, commits it, and publishes bounded Agent presence", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const awareness = new Awareness(doc);
    awareness.setLocalState({ user: { id: "ada", name: "Ada", color: "#3366ff" } });
    let finishCommit!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => { finishCommit = resolve; }));
    cleanups.push(registerAgentSpreadsheetDocument("data.lattice-sheet", {
      doc,
      canWrite: true,
      awareness,
      commit,
    }));

    const pending = executeAgentSpreadsheetToolRequest(request("batch_update", {
      version: 1,
      path: "data.lattice-sheet",
      operations: [{ type: "set_values", range: "A1:B1", values: [[7, "result"]] }],
    }));
    await vi.waitFor(() => expect(awareness.getLocalState()?.spreadsheetAgentPresence).toMatchObject({
      selections: ["A1:B1"],
      agent: true,
    }));
    finishCommit();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { appliedOperations: 1, affectedCells: 2, workbookRevision: 1 },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(awareness.getLocalState()?.spreadsheetAgentPresence).toBeNull();
    expect(readSpreadsheet(doc, { range: "A1:B1", include: ["values"] }).values).toEqual([[7, "result"]]);
    awareness.destroy();
    doc.destroy();
  });

  it("stores quoted plain numbers from the Agent as numeric cells", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    cleanups.push(registerAgentSpreadsheetDocument("data.lattice-sheet", { doc, canWrite: true }));

    await expect(executeAgentSpreadsheetToolRequest(request("batch_update", {
      version: 1,
      path: "data.lattice-sheet",
      operations: [{ type: "set_values", range: "A1:B1", values: [["0.764", "780"]] }],
    }))).resolves.toMatchObject({ ok: true });
    expect(readSpreadsheet(doc, { range: "A1:B1", include: ["values"] }).values).toEqual([[0.764, 780]]);
    doc.destroy();
  });

  it("rejects expired, invalid, and read-only updates without partial writes", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    cleanups.push(registerAgentSpreadsheetDocument("readonly.lattice-sheet", { doc, canWrite: false }));

    await expect(executeAgentSpreadsheetToolRequest(request("batch_update", {
      path: "readonly.lattice-sheet",
      operations: [{ type: "set_values", range: "A1", values: [[1]] }],
    }))).resolves.toMatchObject({ ok: false, error: { code: "spreadsheet_read_only" } });
    expect(readSpreadsheet(doc, { range: "A1", include: ["values"] }).values).toEqual([[null]]);

    const expired = request("read", { path: "readonly.lattice-sheet", range: "A1" });
    expired.expiresAt = Date.now() - 1;
    await expect(executeAgentSpreadsheetToolRequest(expired)).resolves.toMatchObject({
      ok: false,
      error: { code: "spreadsheet_tool_expired" },
    });
    doc.destroy();
  });

  it("sideloads an unopened document and disposes the resolver-owned Y.Doc", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const dispose = vi.fn(() => doc.destroy());
    cleanups.push(registerAgentSpreadsheetDocumentResolver(async (path) => (
      path === "unopened.lattice-sheet" ? { doc, canWrite: true, dispose } : null
    )));

    await expect(executeAgentSpreadsheetToolRequest(request("read", {
      path: "unopened.lattice-sheet",
      range: "A1",
    }))).resolves.toMatchObject({ ok: true });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps unfocused open sheets registered and prefers the focused pane", async () => {
    const unfocusedDoc = new Y.Doc();
    const focusedDoc = new Y.Doc();
    seedSpreadsheetDoc(unfocusedDoc);
    seedSpreadsheetDoc(focusedDoc);
    applySpreadsheetBatch(unfocusedDoc, {
      operations: [{ type: "set_values", range: "A1", values: [["unfocused"]] }],
    });
    applySpreadsheetBatch(focusedDoc, {
      operations: [{ type: "set_values", range: "A1", values: [["focused"]] }],
    });
    cleanups.push(registerAgentSpreadsheetDocument(
      "two-pane.lattice-sheet",
      { doc: unfocusedDoc, canWrite: true },
      false,
    ));
    const unregisterFocused = registerAgentSpreadsheetDocument(
      "two-pane.lattice-sheet",
      { doc: focusedDoc, canWrite: true },
      true,
    );
    cleanups.push(unregisterFocused);

    await expect(executeAgentSpreadsheetToolRequest(request("read", {
      path: "two-pane.lattice-sheet",
      range: "A1",
    }))).resolves.toMatchObject({ ok: true, result: { values: [["focused"]] } });

    unregisterFocused();
    await expect(executeAgentSpreadsheetToolRequest(request("read", {
      path: "two-pane.lattice-sheet",
      range: "A1",
    }))).resolves.toMatchObject({ ok: true, result: { values: [["unfocused"]] } });
    focusedDoc.destroy();
    unfocusedDoc.destroy();
  });

  it("does not invite a duplicate structural update when persistence is unconfirmed", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(undefined);
    cleanups.push(registerAgentSpreadsheetDocument("retry.lattice-sheet", { doc, canWrite: true, commit }));
    const update = request("batch_update", {
      path: "retry.lattice-sheet",
      operations: [{ type: "insert_rows", before: 2, count: 1 }],
    });

    await expect(executeAgentSpreadsheetToolRequest(update)).resolves.toMatchObject({
      ok: true,
      result: {
        appliedOperations: 1,
        workbookRevision: 1,
        persistenceConfirmed: false,
        warning: expect.stringMatching(/spreadsheet_read/),
      },
    });
    expect(readSpreadsheet(doc, { range: "A1" }).sheet).toMatchObject({ rows: 101 });

    await expect(executeAgentSpreadsheetToolRequest(update)).resolves.toMatchObject({
      ok: true,
      result: { appliedOperations: 1, workbookRevision: 1, persistenceConfirmed: true },
    });
    expect(readSpreadsheet(doc, { range: "A1" }).sheet).toMatchObject({ rows: 101 });
    expect(commit).toHaveBeenCalledTimes(2);
    doc.destroy();
  });
});
