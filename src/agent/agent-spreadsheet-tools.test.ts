import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  executeAgentSpreadsheetToolRequest,
  parseAgentSpreadsheetToolRequest,
  registerAgentSpreadsheetDocument,
  registerAgentSpreadsheetDocumentResolver,
  SYNARA_SPREADSHEET_TOOL_REQUEST,
  type AgentSpreadsheetToolRequest,
  waitForAgentSpreadsheetDocument,
} from "./agent-spreadsheet-tools";
import { applySpreadsheetBatch, readSpreadsheet } from "../editor/spreadsheet/spreadsheet-operations";
import { seedSpreadsheetDoc } from "../editor/spreadsheet/spreadsheet-yjs";
import type { SpreadsheetCellValue } from "../editor/spreadsheet/spreadsheet-types";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A seeded workbook, destroyed after the test. */
function seededDoc(values?: SpreadsheetCellValue[][]): Y.Doc {
  const doc = new Y.Doc();
  seedSpreadsheetDoc(doc);
  if (values) applySpreadsheetBatch(doc, { operations: [{ type: "set_values", range: "A1", values }] });
  cleanups.push(() => doc.destroy());
  return doc;
}

type Action = AgentSpreadsheetToolRequest["action"];

function request(action: Action, args: Record<string, unknown>): AgentSpreadsheetToolRequest {
  return {
    type: SYNARA_SPREADSHEET_TOOL_REQUEST, version: 1, id: crypto.randomUUID(), action, args,
    expiresAt: Date.now() + 10_000,
  };
}

const execute = (action: Action, args: Record<string, unknown>) =>
  executeAgentSpreadsheetToolRequest(request(action, args));
const readA1 = (path: string) => execute("read", { path, range: "A1" });
const values = (doc: Y.Doc, range: string) => readSpreadsheet(doc, { range, include: ["values"] }).values;

describe("agent spreadsheet host protocol", () => {
  it("strictly parses bounded, versioned request envelopes", () => {
    const valid = request("read", { path: "tables/data.lattice-sheet", range: "A1" });
    expect(parseAgentSpreadsheetToolRequest(valid)).toEqual(valid);
    expect(parseAgentSpreadsheetToolRequest({ ...valid, version: 2 })).toBeNull();
    expect(parseAgentSpreadsheetToolRequest({ ...valid, unexpected: true })).toBeNull();
    expect(parseAgentSpreadsheetToolRequest({ ...valid, action: "command" })).toBeNull();
    expect(parseAgentSpreadsheetToolRequest({ ...valid, args: { value: "界".repeat(100_000) } })).toBeNull();
  });

  it("applies one semantic batch and commits it", async () => {
    const doc = seededDoc();
    const commit = vi.fn(async () => undefined);
    cleanups.push(registerAgentSpreadsheetDocument("data.lattice-sheet", { doc, canWrite: true, commit }));
    await expect(execute("batch_update", {
      version: 1,
      path: "data.lattice-sheet",
      operations: [{ type: "set_values", range: "A1:B1", values: [[7, "result"]] }],
    })).resolves.toMatchObject({
      ok: true, result: { appliedOperations: 1, affectedCells: 2, workbookRevision: 1 },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(values(doc, "A1:B1")).toEqual([[7, "result"]]);
  });

  it("stores quoted plain numbers from the Agent as numeric cells", async () => {
    const doc = seededDoc();
    cleanups.push(registerAgentSpreadsheetDocument("data.lattice-sheet", { doc, canWrite: true }));
    await expect(execute("batch_update", {
      version: 1,
      path: "data.lattice-sheet",
      operations: [{ type: "set_values", range: "A1:B1", values: [["0.764", "780"]] }],
    })).resolves.toMatchObject({ ok: true });
    expect(values(doc, "A1:B1")).toEqual([[0.764, 780]]);
  });

  it("rejects expired, invalid, and read-only updates without partial writes", async () => {
    const doc = seededDoc();
    cleanups.push(registerAgentSpreadsheetDocument("readonly.lattice-sheet", { doc, canWrite: false }));
    await expect(execute("batch_update", {
      path: "readonly.lattice-sheet",
      operations: [{ type: "set_values", range: "A1", values: [[1]] }],
    })).resolves.toMatchObject({ ok: false, error: { code: "spreadsheet_read_only" } });
    expect(values(doc, "A1")).toEqual([[null]]);
    const expired = request("read", { path: "readonly.lattice-sheet", range: "A1" });
    expired.expiresAt = Date.now() - 1;
    await expect(executeAgentSpreadsheetToolRequest(expired)).resolves.toMatchObject({
      ok: false, error: { code: "spreadsheet_tool_expired" },
    });
  });

  it("sideloads an unopened document and disposes the resolver-owned Y.Doc", async () => {
    const doc = seededDoc();
    const dispose = vi.fn();
    cleanups.push(registerAgentSpreadsheetDocumentResolver(async (path) => (
      path === "unopened.lattice-sheet" ? { doc, canWrite: true, dispose } : null
    )));
    await expect(readA1("unopened.lattice-sheet")).resolves.toMatchObject({ ok: true });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps unfocused open sheets registered and prefers the focused pane", async () => {
    const path = "two-pane.lattice-sheet";
    cleanups.push(registerAgentSpreadsheetDocument(path, { doc: seededDoc([["unfocused"]]), canWrite: true }, false));
    const unregisterFocused = registerAgentSpreadsheetDocument(path, { doc: seededDoc([["focused"]]), canWrite: true }, true);
    cleanups.push(unregisterFocused);
    await expect(readA1(path)).resolves.toMatchObject({ ok: true, result: { values: [["focused"]] } });
    unregisterFocused();
    await expect(readA1(path)).resolves.toMatchObject({ ok: true, result: { values: [["unfocused"]] } });
  });

  it("waits until the requested spreadsheet editor registers its live document", async () => {
    const doc = seededDoc();
    let settled = false;
    const waiting = waitForAgentSpreadsheetDocument("new.lattice-sheet", 1_000)
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanups.push(registerAgentSpreadsheetDocument("new.lattice-sheet", { doc, canWrite: true }));
    await waiting;
    expect(settled).toBe(true);
  });

  it("does not invite a duplicate structural update when persistence is unconfirmed", async () => {
    const doc = seededDoc();
    const commit = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValueOnce(undefined);
    cleanups.push(registerAgentSpreadsheetDocument("retry.lattice-sheet", { doc, canWrite: true, commit }));
    const update = request("batch_update", {
      path: "retry.lattice-sheet", operations: [{ type: "insert_rows", before: 2, count: 1 }],
    });
    await expect(executeAgentSpreadsheetToolRequest(update)).resolves.toMatchObject({
      ok: true,
      result: {
        appliedOperations: 1, workbookRevision: 1, persistenceConfirmed: false,
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
  });
});
