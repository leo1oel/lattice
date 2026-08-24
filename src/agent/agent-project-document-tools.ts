/* eslint lingui/no-unlocalized-strings: "off" -- Protocol field names and Agent diagnostics are never rendered by Lattice UI. */

export const SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST = "synara:project-document-tool-request";
const LATTICE_PROJECT_DOCUMENT_TOOL_RESULT = "lattice:project-document-tool-result";

export type AgentProjectDocumentType = "board" | "spreadsheet";

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

export type AgentProjectDocumentToolResult = {
  type: typeof LATTICE_PROJECT_DOCUMENT_TOOL_RESULT;
  version: 1;
  id: string;
  ok: boolean;
  result?: { path: string; documentType: AgentProjectDocumentType; opened: true };
  error?: { code: string; message: string };
};

type AgentProjectDocumentCreator = (
  request: AgentProjectDocumentToolRequest,
) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasExpectedExtension(path: string, documentType: AgentProjectDocumentType): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(
    documentType === "board" ? ".tldr" : ".lattice-sheet",
  );
}

export function parseAgentProjectDocumentToolRequest(
  value: unknown,
): AgentProjectDocumentToolRequest | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ["type", "version", "id", "args", "expiresAt"])
    || value.type !== SYNARA_PROJECT_DOCUMENT_TOOL_REQUEST
    || value.version !== 1
    || typeof value.id !== "string"
    || value.id.length === 0
    || value.id.length > 128
    || typeof value.expiresAt !== "number"
    || !Number.isFinite(value.expiresAt)
    || !isRecord(value.args)
    || !hasOnlyKeys(value.args, ["path", "documentType"])
  ) {
    return null;
  }
  const { path, documentType } = value.args;
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > 1_024
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || (documentType !== "board" && documentType !== "spreadsheet")
    || !hasExpectedExtension(path, documentType)
  ) {
    return null;
  }
  return value as AgentProjectDocumentToolRequest;
}

export async function executeAgentProjectDocumentToolRequest(
  request: AgentProjectDocumentToolRequest,
  createDocument: AgentProjectDocumentCreator | null,
): Promise<AgentProjectDocumentToolResult> {
  try {
    if (request.expiresAt <= Date.now()) {
      throw Object.assign(new Error("The project document request expired before execution."), {
        code: "project_document_tool_expired",
      });
    }
    if (!createDocument) {
      throw Object.assign(new Error("The Lattice project document host is unavailable."), {
        code: "project_document_host_unavailable",
      });
    }
    const path = await createDocument(request);
    if (path !== request.args.path) {
      throw Object.assign(new Error("Lattice created the project document at an unexpected path."), {
        code: "project_document_path_mismatch",
      });
    }
    return {
      type: LATTICE_PROJECT_DOCUMENT_TOOL_RESULT,
      version: 1,
      id: request.id,
      ok: true,
      result: { path, documentType: request.args.documentType, opened: true },
    };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string"
      ? error.code
      : "project_document_create_failed";
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: LATTICE_PROJECT_DOCUMENT_TOOL_RESULT,
      version: 1,
      id: request.id,
      ok: false,
      error: { code: code.slice(0, 128), message: message.slice(0, 2_000) },
    };
  }
}
