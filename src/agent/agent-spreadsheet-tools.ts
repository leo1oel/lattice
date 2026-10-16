/* eslint-disable lingui/no-unlocalized-strings -- Protocol keys and Agent tool errors/results are never rendered by Lattice UI. */

import type * as Y from "yjs";
import { isRecord } from "../app-utils";
import { chunk } from "../lib/lazy-chunk";
import {
  createOpenWaiters,
  isWorkspaceRelativePath,
  jsonBytes,
  parseToolEnvelope,
  runAgentTool,
  toolError,
  type AgentToolResult,
} from "./agent-protocol";

export const SYNARA_SPREADSHEET_TOOL_REQUEST = "synara:spreadsheet-tool-request";
const LATTICE_SPREADSHEET_TOOL_RESULT = "lattice:spreadsheet-tool-result";

const ACTIONS = ["read", "batch_update"] as const;
type AgentSpreadsheetAction = (typeof ACTIONS)[number];

export type AgentSpreadsheetToolRequest = {
  type: typeof SYNARA_SPREADSHEET_TOOL_REQUEST;
  version: 1;
  id: string;
  action: AgentSpreadsheetAction;
  args: Record<string, unknown>;
  expiresAt: number;
};

/**
 * Yjs and the spreadsheet operations, kept out of the startup chunk: only a
 * spreadsheet request needs them, and it loads them here (App's resolver too).
 */
export const loadAgentSpreadsheetModel = chunk(() => import("./agent-spreadsheet-model"));

export type AgentSpreadsheetToolResult = AgentToolResult<typeof LATTICE_SPREADSHEET_TOOL_RESULT>;

export type AgentSpreadsheetDocument = {
  doc: Y.Doc;
  canWrite: boolean;
  commit?: () => Promise<void>;
  path?: string;
  dispose?: () => void;
};

type AgentSpreadsheetDocumentResolver = (path: string) => Promise<AgentSpreadsheetDocument | null>;

type OpenAgentSpreadsheetDocument = {
  document: AgentSpreadsheetDocument;
  active: boolean;
};

const openDocuments = new Map<string, Set<OpenAgentSpreadsheetDocument>>();
const documentWaiters = createOpenWaiters();
let documentResolver: AgentSpreadsheetDocumentResolver | null = null;

function requestPath(args: Record<string, unknown>): string {
  const path = args.path;
  if (!isWorkspaceRelativePath(path) || !path.endsWith(".lattice-sheet")) {
    throw toolError("path must be a normalized workspace-relative .lattice-sheet path.", "spreadsheet_invalid_path");
  }
  return path;
}

function withoutRoutingFields(args: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, version: _version, ...operationArgs } = args;
  return operationArgs;
}

export function registerAgentSpreadsheetDocument(
  path: string,
  document: AgentSpreadsheetDocument,
  active = true,
): () => void {
  const registration = { document, active };
  const registrations = openDocuments.get(path) ?? new Set<OpenAgentSpreadsheetDocument>();
  registrations.add(registration);
  openDocuments.set(path, registrations);
  documentWaiters.notify(path);
  return () => {
    registrations.delete(registration);
    if (registrations.size === 0 && openDocuments.get(path) === registrations) {
      openDocuments.delete(path);
    }
  };
}

export function waitForAgentSpreadsheetDocument(path: string, timeoutMs: number): Promise<void> {
  return documentWaiters.wait(
    path,
    timeoutMs,
    (openDocuments.get(path)?.size ?? 0) > 0,
    `The spreadsheet did not open before the request expired: ${path}`,
  );
}

export function registerAgentSpreadsheetDocumentResolver(resolver: AgentSpreadsheetDocumentResolver): () => void {
  documentResolver = resolver;
  return () => {
    if (documentResolver === resolver) documentResolver = null;
  };
}

export function parseAgentSpreadsheetToolRequest(value: unknown): AgentSpreadsheetToolRequest | null {
  const request = parseToolEnvelope(value, SYNARA_SPREADSHEET_TOOL_REQUEST, ["action", "args"]);
  if (!request || !ACTIONS.includes(request.action as AgentSpreadsheetAction) || !isRecord(request.args)) return null;
  const argsBytes = jsonBytes(request.args);
  if (argsBytes === null || argsBytes > 256 * 1024) return null;
  return request as AgentSpreadsheetToolRequest;
}

export async function executeAgentSpreadsheetToolRequest(
  request: AgentSpreadsheetToolRequest,
): Promise<AgentSpreadsheetToolResult> {
  // Released only after the reply is built, however the request ends.
  const held: { document?: AgentSpreadsheetDocument | null } = {};
  try {
    return await runAgentTool(LATTICE_SPREADSHEET_TOOL_RESULT, request.id, "spreadsheet_tool_failed", async () => {
      if (request.expiresAt <= Date.now()) {
        throw toolError("The spreadsheet request expired before execution.", "spreadsheet_tool_expired");
      }
      const path = requestPath(request.args);
      const model = await loadAgentSpreadsheetModel();
      const registrations = [...(openDocuments.get(path) ?? [])];
      const document = held.document = registrations.find((registration) => registration.active)?.document
        ?? registrations.at(-1)?.document
        ?? await documentResolver?.(path)
        ?? null;
      if (!document) throw toolError(`Spreadsheet not found: ${path}`, "spreadsheet_not_found");
      const args = withoutRoutingFields(request.args);
      let result: unknown;
      if (request.action === "read") {
        result = model.readSpreadsheetRange(document.doc, args);
      } else {
        if (!document.canWrite) throw toolError("This spreadsheet is read-only.", "spreadsheet_read_only");
        const applied = model.recordedBatchResult(document.doc, request, args);
        try {
          await document.commit?.();
          result = { ...applied, persistenceConfirmed: true };
        } catch {
          // The broker-generated request ID is not visible to the Agent, so an
          // error here would invite a new tool call with a new ID and could apply
          // non-idempotent operations (insert rows, for example) twice. Report
          // the applied mutation honestly and make the required next step a read:
          // that distinguishes a failed local write from an update already held
          // by the open spreadsheet's Y.Doc without replaying it speculatively.
          result = {
            ...applied,
            persistenceConfirmed: false,
            warning: "The update was applied, but disk persistence was not confirmed. Use spreadsheet_read to verify the affected range before issuing another update.",
          };
        }
      }
      const resultBytes = jsonBytes(result);
      if (resultBytes === null || resultBytes > 384 * 1024) throw toolError("The spreadsheet result is too large.", "spreadsheet_result_too_large");
      return result;
    });
  } finally {
    held.document?.dispose?.();
  }
}
