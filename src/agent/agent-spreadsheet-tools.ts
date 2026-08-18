import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  applySpreadsheetBatch,
  parseSpreadsheetBatchUpdateArgs,
  parseSpreadsheetReadArgs,
  readSpreadsheet,
} from "../editor/spreadsheet/spreadsheet-operations";
import type { SpreadsheetBatchUpdateRequest } from "../editor/spreadsheet/spreadsheet-types";
import { SPREADSHEET_AGENT_ORIGIN, spreadsheetSnapshotFromDoc } from "../editor/spreadsheet/spreadsheet-yjs";

export const SYNARA_SPREADSHEET_TOOL_REQUEST = "synara:spreadsheet-tool-request";
const LATTICE_SPREADSHEET_TOOL_RESULT = "lattice:spreadsheet-tool-result";

type AgentSpreadsheetAction = "read" | "batch_update";

export type AgentSpreadsheetToolRequest = {
  type: typeof SYNARA_SPREADSHEET_TOOL_REQUEST;
  version: 1;
  id: string;
  action: AgentSpreadsheetAction;
  args: Record<string, unknown>;
  expiresAt: number;
};

export type AgentSpreadsheetToolResult = {
  type: typeof LATTICE_SPREADSHEET_TOOL_RESULT;
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type AgentSpreadsheetDocument = {
  doc: Y.Doc;
  canWrite: boolean;
  commit?: () => Promise<void>;
  awareness?: Awareness | null;
  path?: string;
  dispose?: () => void;
};

type AgentSpreadsheetDocumentResolver = (path: string) => Promise<AgentSpreadsheetDocument | null>;

type OpenAgentSpreadsheetDocument = {
  document: AgentSpreadsheetDocument;
  active: boolean;
};

const openDocuments = new Map<string, Set<OpenAgentSpreadsheetDocument>>();
let documentResolver: AgentSpreadsheetDocumentResolver | null = null;
const SPREADSHEET_AGENT_PRESENCE_FIELD = "spreadsheetAgentPresence";
const SPREADSHEET_AGENT_REQUESTS_KEY = "spreadsheetAgentRequests";
const MAX_RECORDED_AGENT_REQUESTS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function jsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function requestPath(args: Record<string, unknown>): string {
  const path = args.path;
  if (typeof path !== "string" || path.length === 0 || path.length > 1_024
    || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || !path.endsWith(".lattice-sheet")) {
    throw Object.assign(new Error("path must be a normalized workspace-relative .lattice-sheet path."), { code: "spreadsheet_invalid_path" });
  }
  return path;
}

function withoutRoutingFields(args: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, version: _version, ...operationArgs } = args;
  return operationArgs;
}

function recordedBatchResult(
  document: AgentSpreadsheetDocument,
  request: AgentSpreadsheetToolRequest,
  batch: SpreadsheetBatchUpdateRequest,
): { appliedOperations: number; affectedCells: number; workbookRevision: number } {
  const requests = document.doc.getMap<unknown>(SPREADSHEET_AGENT_REQUESTS_KEY);
  const fingerprint = JSON.stringify({ action: request.action, args: request.args });
  const prior = requests.get(request.id);
  if (isRecord(prior)) {
    if (prior.fingerprint !== fingerprint || !isRecord(prior.result)) {
      throw Object.assign(new Error("This spreadsheet request ID was already used for a different payload."), {
        code: "spreadsheet_request_id_conflict",
      });
    }
    return prior.result as { appliedOperations: number; affectedCells: number; workbookRevision: number };
  }

  let result!: { appliedOperations: number; affectedCells: number; workbookRevision: number };
  document.doc.transact(() => {
    result = applySpreadsheetBatch(document.doc, batch);
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

function publishAgentPresence(
  document: AgentSpreadsheetDocument,
  path: string,
  request: SpreadsheetBatchUpdateRequest,
): (() => void) | undefined {
  const awareness = document.awareness;
  if (!awareness) return undefined;
  const workbook = spreadsheetSnapshotFromDoc(document.doc);
  const rangeOperations = request.operations.filter((operation) => "range" in operation);
  const requestedSheet = request.operations
    .map((operation) => "sheet" in operation ? operation.sheet : undefined)
    .find((sheet) => sheet !== undefined);
  const sheetId = requestedSheet && workbook.sheets[requestedSheet]
    ? requestedSheet
    : requestedSheet
      ? workbook.sheetOrder.find((id) => workbook.sheets[id]?.name.toLocaleLowerCase() === requestedSheet.toLocaleLowerCase())
      : workbook.sheetOrder[0];
  if (!sheetId) return undefined;
  const selections = rangeOperations.map((operation) => operation.range);
  const prior = awareness.getLocalState()?.[SPREADSHEET_AGENT_PRESENCE_FIELD] ?? null;
  awareness.setLocalStateField(SPREADSHEET_AGENT_PRESENCE_FIELD, {
    path,
    sheetId,
    selections,
    ...(selections[0] ? { activeCell: selections[0] } : {}),
    agent: true,
  });
  return () => awareness.setLocalStateField(SPREADSHEET_AGENT_PRESENCE_FIELD, prior);
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
  return () => {
    registrations.delete(registration);
    if (registrations.size === 0 && openDocuments.get(path) === registrations) {
      openDocuments.delete(path);
    }
  };
}

export function registerAgentSpreadsheetDocumentResolver(resolver: AgentSpreadsheetDocumentResolver): () => void {
  documentResolver = resolver;
  return () => {
    if (documentResolver === resolver) documentResolver = null;
  };
}

export function parseAgentSpreadsheetToolRequest(value: unknown): AgentSpreadsheetToolRequest | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["type", "version", "id", "action", "args", "expiresAt"])
    || value.type !== SYNARA_SPREADSHEET_TOOL_REQUEST || value.version !== 1) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return null;
  if (value.action !== "read" && value.action !== "batch_update") return null;
  if (!isRecord(value.args)) return null;
  const argsBytes = jsonBytes(value.args);
  if (argsBytes === null || argsBytes > 256 * 1024) return null;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
  return value as AgentSpreadsheetToolRequest;
}

export async function executeAgentSpreadsheetToolRequest(
  request: AgentSpreadsheetToolRequest,
): Promise<AgentSpreadsheetToolResult> {
  let document: AgentSpreadsheetDocument | null = null;
  let restoreAgentPresence: (() => void) | undefined;
  try {
    if (request.expiresAt <= Date.now()) {
      throw Object.assign(new Error("The spreadsheet request expired before execution."), { code: "spreadsheet_tool_expired" });
    }
    const path = requestPath(request.args);
    const registrations = [...(openDocuments.get(path) ?? [])];
    document = registrations.find((registration) => registration.active)?.document
      ?? registrations.at(-1)?.document
      ?? await documentResolver?.(path)
      ?? null;
    if (!document) throw Object.assign(new Error(`Spreadsheet not found: ${path}`), { code: "spreadsheet_not_found" });
    const args = withoutRoutingFields(request.args);
    let result: unknown;
    if (request.action === "read") {
      const readArgs = parseSpreadsheetReadArgs(args);
      if (!readArgs.range) throw new Error("range is required.");
      result = readSpreadsheet(document.doc, readArgs);
    } else {
      if (!document.canWrite) throw Object.assign(new Error("This spreadsheet is read-only."), { code: "spreadsheet_read_only" });
      const batch = parseSpreadsheetBatchUpdateArgs(args);
      restoreAgentPresence = publishAgentPresence(document, path, batch);
      const applied = recordedBatchResult(document, request, batch);
      try {
        await document.commit?.();
        result = { ...applied, persistenceConfirmed: true };
      } catch {
        // The broker-generated request ID is not visible to the Agent, so an
        // error here would invite a new tool call with a new ID and could apply
        // non-idempotent operations (insert rows, for example) twice. Report
        // the applied mutation honestly and make the required next step a read:
        // that distinguishes a failed local write from an update already held
        // by the live collaborative Y.Doc without replaying it speculatively.
        result = {
          ...applied,
          persistenceConfirmed: false,
          warning: "The update was applied, but collaboration and disk persistence were not confirmed. Use spreadsheet_read to verify the affected range before issuing another update.",
        };
      }
    }
    const resultBytes = jsonBytes(result);
    if (resultBytes === null || resultBytes > 384 * 1024) throw Object.assign(new Error("The spreadsheet result is too large."), { code: "spreadsheet_result_too_large" });
    return { type: LATTICE_SPREADSHEET_TOOL_RESULT, version: 1, id: request.id, ok: true, result };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "spreadsheet_tool_failed";
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: LATTICE_SPREADSHEET_TOOL_RESULT,
      version: 1,
      id: request.id,
      ok: false,
      error: { code: code.slice(0, 128), message: message.slice(0, 2_000) },
    };
  } finally {
    restoreAgentPresence?.();
    document?.dispose?.();
  }
}
