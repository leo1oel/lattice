/* eslint-disable lingui/no-unlocalized-strings -- Protocol field names and Agent diagnostics are never rendered by Lattice UI. */

import { isRecord } from "../app-utils";
import {
  hasOnlyKeys,
  isWorkspaceRelativePath,
  parseToolEnvelope,
  runAgentTool,
  toolError,
  type AgentToolResult,
} from "./agent-protocol";

export const SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST = "synara:project-document-tool-request";
const LATTICE_PROJECT_DOCUMENT_TOOL_RESULT = "lattice:project-document-tool-result";

type AgentProjectDocumentType = "board" | "spreadsheet";

const EXTENSIONS: Record<AgentProjectDocumentType, string> = { board: ".excalidraw", spreadsheet: ".lattice-sheet" };
// A Synara runtime pinned before boards became Excalidraw still names a new
// board `.tldr`; it is created as the `.excalidraw` it would convert to.
const LEGACY_BOARD_EXTENSION = ".tldr";

export type AgentProjectDocumentToolRequest = {
  type: typeof SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST;
  version: 1;
  id: string;
  args: {
    path: string;
    documentType: AgentProjectDocumentType;
  };
  expiresAt: number;
};

export type AgentProjectDocumentToolResult = AgentToolResult<
  typeof LATTICE_PROJECT_DOCUMENT_TOOL_RESULT,
  { path: string; documentType: AgentProjectDocumentType; opened: true }
>;

type AgentProjectDocumentCreator = (
  request: AgentProjectDocumentToolRequest,
) => Promise<string>;

export function parseAgentProjectDocumentToolRequest(
  value: unknown,
): AgentProjectDocumentToolRequest | null {
  const request = parseToolEnvelope(value, SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST, ["args"]);
  if (!request || !isRecord(request.args) || !hasOnlyKeys(request.args, ["path", "documentType"])) return null;
  const { documentType } = request.args;
  let { path } = request.args;
  if (!isWorkspaceRelativePath(path) || (documentType !== "board" && documentType !== "spreadsheet")) return null;
  const lower = path.toLocaleLowerCase("en-US");
  if (documentType === "board" && lower.endsWith(LEGACY_BOARD_EXTENSION)) {
    path = `${path.slice(0, -LEGACY_BOARD_EXTENSION.length)}${EXTENSIONS.board}`;
  } else if (!lower.endsWith(EXTENSIONS[documentType])) {
    return null;
  }
  return { ...request, args: { path, documentType } } as AgentProjectDocumentToolRequest;
}

/**
 * The answer to a project document request whose envelope is Synara's but
 * whose arguments Lattice refuses, so the Agent hears why at once instead of
 * waiting out its deadline. Null for anything that is not such a request.
 */
export function rejectAgentProjectDocumentToolRequest(value: unknown): Promise<AgentProjectDocumentToolResult> | null {
  const envelope = parseToolEnvelope(value, SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST);
  if (!envelope) return null;
  return runAgentTool(LATTICE_PROJECT_DOCUMENT_TOOL_RESULT, envelope.id as string, "project_document_invalid_arguments", async () => {
    throw toolError(
      "path must be a normalized workspace-relative path ending in .excalidraw for a board or .lattice-sheet for a spreadsheet.",
      "project_document_invalid_arguments",
    );
  });
}

export function executeAgentProjectDocumentToolRequest(
  request: AgentProjectDocumentToolRequest,
  createDocument: AgentProjectDocumentCreator | null,
): Promise<AgentProjectDocumentToolResult> {
  return runAgentTool(LATTICE_PROJECT_DOCUMENT_TOOL_RESULT, request.id, "project_document_create_failed", async () => {
    if (request.expiresAt <= Date.now()) {
      throw toolError("The project document request expired before execution.", "project_document_tool_expired");
    }
    if (!createDocument) {
      throw toolError("The Lattice project document host is unavailable.", "project_document_host_unavailable");
    }
    const path = await createDocument(request);
    if (path !== request.args.path) {
      throw toolError("Lattice created the project document at an unexpected path.", "project_document_path_mismatch");
    }
    return { path, documentType: request.args.documentType, opened: true as const };
  });
}
