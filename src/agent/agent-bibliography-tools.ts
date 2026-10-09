/* eslint-disable lingui/no-unlocalized-strings -- Protocol field names and Agent diagnostics are never rendered by Lattice UI. */

import { invoke } from "@tauri-apps/api/core";
import { isRecord } from "../app-utils";
import {
  hasOnlyKeys,
  isNonBlankString,
  jsonBytes,
  parseToolEnvelope,
  runAgentTool,
  toolError,
  type AgentToolResult,
} from "./agent-protocol";

const SYNARA_BIBLIOGRAPHY_TOOL_REQUEST = "synara:bibliography-tool-request";
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

export type AgentBibliographyToolResult = AgentToolResult<typeof LATTICE_BIBLIOGRAPHY_TOOL_RESULT, Record<string, unknown>>;

/** The only parameters each typed mutation accepts. */
const PARAM_VALIDATORS: Record<AgentBibliographyAction, (params: Record<string, unknown>) => boolean> = {
  cite: (params) => hasOnlyKeys(params, ["query"]) && isNonBlankString(params.query, 4_096),
  upgrade_bibliography: (params) => hasOnlyKeys(params, ["dryRun"])
    && (params.dryRun === undefined || typeof params.dryRun === "boolean"),
  remove_reference: (params) => hasOnlyKeys(params, ["key"]) && isNonBlankString(params.key, 512),
};

export function parseAgentBibliographyToolRequest(
  value: unknown,
): AgentBibliographyToolRequest | null {
  const request = parseToolEnvelope(value, SYNARA_BIBLIOGRAPHY_TOOL_REQUEST, ["action", "params", "workspaceRoot"]);
  if (
    !request
    || !Object.hasOwn(PARAM_VALIDATORS, request.action as string)
    || !isRecord(request.params)
    || !PARAM_VALIDATORS[request.action as AgentBibliographyAction](request.params)
    || !isNonBlankString(request.workspaceRoot, 4_096)
  ) {
    return null;
  }
  return request as AgentBibliographyToolRequest;
}

export function executeAgentBibliographyToolRequest(
  request: AgentBibliographyToolRequest,
  currentProjectRoot: string | null,
): Promise<AgentBibliographyToolResult> {
  return runAgentTool(LATTICE_BIBLIOGRAPHY_TOOL_RESULT, request.id, "bibliography_tool_failed", async () => {
    if (request.expiresAt <= Date.now()) {
      throw toolError("The bibliography request expired before execution.", "bibliography_tool_expired");
    }
    if (!currentProjectRoot || request.workspaceRoot !== currentProjectRoot) {
      throw toolError("The project changed before the bibliography request could start.", "bibliography_project_changed");
    }
    const result = await invoke<unknown>("agent_bibliography_mutation", {
      projectRoot: request.workspaceRoot,
      mutation: { action: request.action, ...request.params },
    });
    const resultBytes = jsonBytes(result);
    if (!isRecord(result) || resultBytes === null || resultBytes > 384 * 1024) {
      throw toolError("Lattice returned an invalid bibliography result.", "bibliography_host_invalid_result");
    }
    return result;
  });
}
