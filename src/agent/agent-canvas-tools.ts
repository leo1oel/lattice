// Protocol half of the agent canvas tools: request parsing, adapter registry,
// and execution dispatch. Deliberately free of any "tldraw" value import —
// App.tsx loads this module eagerly, and a tldraw import here puts the whole
// ~1.5 MB package in the startup chunk. The tldraw-facing adapter lives in
// agent-canvas-tldraw-adapter.ts, loaded only with the lazy board editor.
import { isRecord } from "../app-utils";
import { createOpenWaiters, parseToolEnvelope, runAgentTool, toolError, type AgentToolResult } from "./agent-protocol";

export const SYNARA_CANVAS_TOOL_REQUEST = "synara:canvas-tool-request";
const LATTICE_CANVAS_TOOL_RESULT = "lattice:canvas-tool-result";

const ACTIONS = ["list", "create", "update", "delete"] as const;
type AgentCanvasAction = (typeof ACTIONS)[number];

export type AgentCanvasToolRequest = {
  type: typeof SYNARA_CANVAS_TOOL_REQUEST;
  version: 1;
  id: string;
  action: AgentCanvasAction;
  args: Record<string, unknown>;
  expiresAt: number;
};

export type AgentCanvasToolResult = AgentToolResult<typeof LATTICE_CANVAS_TOOL_RESULT>;

export type AgentCanvasAdapter = {
  execute(action: AgentCanvasAction, args: Record<string, unknown>): unknown;
};

let activeAdapter: { path: string; adapter: AgentCanvasAdapter } | null = null;
const adapterWaiters = createOpenWaiters();

export function registerAgentCanvasAdapter(path: string, adapter: AgentCanvasAdapter): () => void {
  activeAdapter = { path, adapter };
  adapterWaiters.notify(path);
  return () => {
    if (activeAdapter?.adapter === adapter) activeAdapter = null;
  };
}

export function waitForAgentCanvasAdapter(path: string, timeoutMs: number): Promise<void> {
  return adapterWaiters.wait(
    path,
    timeoutMs,
    activeAdapter?.path === path,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- tool error returned to the Agent model
    `The canvas did not open before the request expired: ${path}`,
  );
}

export function parseAgentCanvasToolRequest(value: unknown): AgentCanvasToolRequest | null {
  const request = parseToolEnvelope(value, SYNARA_CANVAS_TOOL_REQUEST);
  if (!request || !ACTIONS.includes(request.action as AgentCanvasAction) || !isRecord(request.args)) return null;
  return request as AgentCanvasToolRequest;
}

export function executeAgentCanvasToolRequest(request: AgentCanvasToolRequest): Promise<AgentCanvasToolResult> {
  return runAgentTool(LATTICE_CANVAS_TOOL_RESULT, request.id, "canvas_tool_failed", () => {
    if (request.expiresAt <= Date.now()) {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- tool error returned to the Agent model
      throw toolError("The canvas request expired before execution.", "canvas_tool_expired");
    }
    // eslint-disable-next-line lingui/no-unlocalized-strings -- tool error returned to the Agent model
    if (!activeAdapter) throw toolError("Open a .tldr canvas before using canvas tools.", "canvas_not_open");
    return activeAdapter.adapter.execute(request.action, request.args);
  }, false);
}
