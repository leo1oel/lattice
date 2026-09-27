/* eslint lingui/no-unlocalized-strings: "off" -- Protocol field names and Agent diagnostics are never rendered by Lattice UI. */

import {
  hasOnlyKeys,
  isRecord,
  isWorkspaceRelativePath,
  parseToolEnvelope,
  runAgentTool,
  toolError,
  type AgentToolResult,
} from "./agent-protocol";

export const SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST = "synara:project-document-tool-request";
const LATTICE_PROJECT_DOCUMENT_TOOL_RESULT = "lattice:project-document-tool-result";

type AgentProjectDocumentType = "board" | "spreadsheet";

const EXTENSIONS: Record<AgentProjectDocumentType, string> = { board: ".tldr", spreadsheet: ".lattice-sheet" };

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
  const { path, documentType } = request.args;
  if (
    !isWorkspaceRelativePath(path)
    || (documentType !== "board" && documentType !== "spreadsheet")
    || !path.toLocaleLowerCase("en-US").endsWith(EXTENSIONS[documentType])
  ) {
    return null;
  }
  return request as AgentProjectDocumentToolRequest;
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
