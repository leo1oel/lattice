/* eslint-disable lingui/no-unlocalized-strings -- Protocol keys and Agent tool errors/results are never rendered by Lattice UI. */

/**
 * The half of the Agent's spreadsheet tools that touches a workbook: Yjs and
 * the spreadsheet operations. It loads through `loadAgentSpreadsheetModel`
 * (`agent-spreadsheet-tools.ts`) with the first spreadsheet request, not at
 * startup; the registry the editor and App register with stays eager.
 */
import * as Y from "yjs";
import { isRecord } from "../app-utils";
import {
  applySpreadsheetBatch,
  parseSpreadsheetBatchUpdateArgs,
  parseSpreadsheetReadArgs,
  readSpreadsheet,
} from "../editor/spreadsheet/spreadsheet-operations";
import { SPREADSHEET_AGENT_ORIGIN, seedSpreadsheetDoc } from "../editor/spreadsheet/spreadsheet-yjs";
import { toolError } from "./agent-protocol";

export { spreadsheetDocContent } from "../editor/spreadsheet/spreadsheet-yjs";

export type SpreadsheetBatchResult = { appliedOperations: number; affectedCells: number; workbookRevision: number };

const SPREADSHEET_AGENT_REQUESTS_KEY = "spreadsheetAgentRequests";
const MAX_RECORDED_AGENT_REQUESTS = 256;

/** A workbook Y.Doc over a `.lattice-sheet` file's text, for a spreadsheet no editor has open. */
export function openSpreadsheetDoc(content: string): Y.Doc {
  const doc = new Y.Doc();
  if (content) doc.getText("content").insert(0, content);
  seedSpreadsheetDoc(doc);
  return doc;
}

export function readSpreadsheetRange(doc: Y.Doc, args: Record<string, unknown>): Record<string, unknown> {
  const readArgs = parseSpreadsheetReadArgs(args);
  if (!readArgs.range) throw new Error("range is required.");
  return readSpreadsheet(doc, readArgs);
}

/** Applies a batch once per request ID: a replayed ID returns the recorded result. */
export function recordedBatchResult(
  doc: Y.Doc,
  request: { id: string; action: string; args: Record<string, unknown> },
  args: Record<string, unknown>,
): SpreadsheetBatchResult {
  const batch = parseSpreadsheetBatchUpdateArgs(args);
  const requests = doc.getMap<unknown>(SPREADSHEET_AGENT_REQUESTS_KEY);
  const fingerprint = JSON.stringify({ action: request.action, args: request.args });
  const prior = requests.get(request.id);
  if (isRecord(prior)) {
    if (prior.fingerprint !== fingerprint || !isRecord(prior.result)) {
      throw toolError("This spreadsheet request ID was already used for a different payload.", "spreadsheet_request_id_conflict");
    }
    return prior.result as SpreadsheetBatchResult;
  }

  let result!: SpreadsheetBatchResult;
  doc.transact(() => {
    result = applySpreadsheetBatch(doc, batch);
    requests.set(request.id, { fingerprint, result, appliedAt: Date.now() });
    if (requests.size > MAX_RECORDED_AGENT_REQUESTS) {
      const oldest = [...requests.entries()]
        .filter(([id, value]) => id !== request.id && isRecord(value) && typeof value.appliedAt === "number")
        .sort(([, left], [, right]) => Number((left as Record<string, unknown>).appliedAt) - Number((right as Record<string, unknown>).appliedAt))[0];
      if (oldest) requests.delete(oldest[0]);
    }
  }, SPREADSHEET_AGENT_ORIGIN);
  return result;
}
