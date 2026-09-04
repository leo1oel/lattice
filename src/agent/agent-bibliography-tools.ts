/* eslint lingui/no-unlocalized-strings: "off" -- Protocol field names and Agent diagnostics are never rendered by Lattice UI. */

import { invoke } from "@tauri-apps/api/core";

export const SYNARA_BIBLIOGRAPHY_TOOL_REQUEST = "synara:bibliography-tool-request";
const LATTICE_BIBLIOGRAPHY_TOOL_RESULT = "lattice:bibliography-tool-result";

type AgentBibliographyAction = "cite" | "upgrade_bibliography" | "remove_reference";

export type AgentBibliographyToolRequest = {
  type: typeof SYNARA_BIBLIOGRAPHY_TOOL_REQUEST;
  version: 1;
  id: string;
  action: AgentBibliographyAction;
  params: Record<string, unknown>;
  workspaceRoot: string;
  expiresAt: number;
};

export type AgentBibliographyToolResult = {
  type: typeof LATTICE_BIBLIOGRAPHY_TOOL_RESULT;
  version: 1;
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function hasValidParams(action: AgentBibliographyAction, params: Record<string, unknown>): boolean {
  if (action === "cite") {
    return hasOnlyKeys(params, ["query"]) && hasBoundedString(params.query, 4_096);
  }
  if (action === "upgrade_bibliography") {
    return hasOnlyKeys(params, ["dryRun"])
      && (params.dryRun === undefined || typeof params.dryRun === "boolean");
  }
  return hasOnlyKeys(params, ["key"]) && hasBoundedString(params.key, 512);
}

function jsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function parseAgentBibliographyToolRequest(
  value: unknown,
): AgentBibliographyToolRequest | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      "type",
      "version",
      "id",
      "action",
      "params",
      "workspaceRoot",
      "expiresAt",
    ])
    || value.type !== SYNARA_BIBLIOGRAPHY_TOOL_REQUEST
    || value.version !== 1
    || typeof value.id !== "string"
    || value.id.length === 0
    || value.id.length > 128
    || (value.action !== "cite"
      && value.action !== "upgrade_bibliography"
      && value.action !== "remove_reference")
    || !isRecord(value.params)
    || !hasValidParams(value.action, value.params)
    || !hasBoundedString(value.workspaceRoot, 4_096)
    || typeof value.expiresAt !== "number"
    || !Number.isFinite(value.expiresAt)
  ) {
    return null;
  }
  return value as AgentBibliographyToolRequest;
}

export async function executeAgentBibliographyToolRequest(
  request: AgentBibliographyToolRequest,
  currentProjectRoot: string | null,
): Promise<AgentBibliographyToolResult> {
  try {
    if (request.expiresAt <= Date.now()) {
      throw Object.assign(new Error("The bibliography request expired before execution."), {
        code: "bibliography_tool_expired",
      });
    }
    if (!currentProjectRoot || request.workspaceRoot !== currentProjectRoot) {
      throw Object.assign(new Error("The project changed before the bibliography request could start."), {
        code: "bibliography_project_changed",
      });
    }
    const result = await invoke<unknown>("agent_bibliography_mutation", {
      projectRoot: request.workspaceRoot,
      mutation: { action: request.action, ...request.params },
    });
    const resultBytes = jsonBytes(result);
    if (!isRecord(result) || resultBytes === null || resultBytes > 384 * 1024) {
      throw Object.assign(new Error("Lattice returned an invalid bibliography result."), {
        code: "bibliography_host_invalid_result",
      });
    }
    return {
      type: LATTICE_BIBLIOGRAPHY_TOOL_RESULT,
      version: 1,
      id: request.id,
      ok: true,
      result,
    };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string"
      ? error.code
      : "bibliography_tool_failed";
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: LATTICE_BIBLIOGRAPHY_TOOL_RESULT,
      version: 1,
      id: request.id,
      ok: false,
      error: { code: code.slice(0, 128), message: message.slice(0, 2_000) },
    };
  }
}
