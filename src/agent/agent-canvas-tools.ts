// Protocol half of the agent canvas tools: request parsing, adapter registry,
// and execution dispatch. Deliberately free of any "tldraw" value import —
// App.tsx loads this module eagerly, and a tldraw import here puts the whole
// ~1.5 MB package in the startup chunk. The tldraw-facing adapter lives in
// agent-canvas-tldraw-adapter.ts, loaded only with the lazy board editor.

export const SYNARA_CANVAS_TOOL_REQUEST = "synara:canvas-tool-request";
const LATTICE_CANVAS_TOOL_RESULT = "lattice:canvas-tool-result";

type AgentCanvasAction = "list" | "create" | "update" | "delete";

export type AgentCanvasToolRequest = {
  type: typeof SYNARA_CANVAS_TOOL_REQUEST;
  version: 1;
  id: string;
  action: AgentCanvasAction;
  args: Record<string, unknown>;
  expiresAt: number;
};

export type AgentCanvasToolResult = {
  type: typeof LATTICE_CANVAS_TOOL_RESULT;
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type AgentCanvasAdapter = {
  execute(action: AgentCanvasAction, args: Record<string, unknown>): unknown;
};

type ActiveAgentCanvasAdapter = {
  path: string;
  adapter: AgentCanvasAdapter;
};

type AgentCanvasWaiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
};

let activeAdapter: ActiveAgentCanvasAdapter | null = null;
const adapterWaiters = new Map<string, Set<AgentCanvasWaiter>>();

export function registerAgentCanvasAdapter(path: string, adapter: AgentCanvasAdapter): () => void {
  activeAdapter = { path, adapter };
  const waiters = adapterWaiters.get(path);
  if (waiters) {
    adapterWaiters.delete(path);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
  return () => {
    if (activeAdapter?.adapter === adapter) activeAdapter = null;
  };
}

export function waitForAgentCanvasAdapter(path: string, timeoutMs: number): Promise<void> {
  if (activeAdapter?.path === path) return Promise.resolve();
  if (timeoutMs <= 0) {
    return Promise.reject(Object.assign(new Error(`The canvas did not open before the request expired: ${path}`), {
      code: "project_document_open_timeout",
    }));
  }
  return new Promise((resolve, reject) => {
    const waiters = adapterWaiters.get(path) ?? new Set<AgentCanvasWaiter>();
    const waiter: AgentCanvasWaiter = {
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) adapterWaiters.delete(path);
        reject(Object.assign(new Error(`The canvas did not open before the request expired: ${path}`), {
          code: "project_document_open_timeout",
        }));
      }, timeoutMs),
    };
    waiters.add(waiter);
    adapterWaiters.set(path, waiters);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAgentCanvasToolRequest(value: unknown): AgentCanvasToolRequest | null {
  if (!isRecord(value) || value.type !== SYNARA_CANVAS_TOOL_REQUEST || value.version !== 1) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return null;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
  if (value.action !== "list" && value.action !== "create" && value.action !== "update" && value.action !== "delete") return null;
  if (!isRecord(value.args)) return null;
  return value as AgentCanvasToolRequest;
}

export async function executeAgentCanvasToolRequest(
  request: AgentCanvasToolRequest,
): Promise<AgentCanvasToolResult> {
  try {
    if (request.expiresAt <= Date.now()) {
      throw Object.assign(new Error("The canvas request expired before execution."), { code: "canvas_tool_expired" });
    }
    if (!activeAdapter) throw Object.assign(new Error("Open a .tldr canvas before using canvas tools."), { code: "canvas_not_open" });
    const result = activeAdapter.adapter.execute(request.action, request.args);
    return { type: LATTICE_CANVAS_TOOL_RESULT, version: 1, id: request.id, ok: true, result };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "canvas_tool_failed";
    const message = error instanceof Error ? error.message : String(error);
    return { type: LATTICE_CANVAS_TOOL_RESULT, version: 1, id: request.id, ok: false, error: { code, message } };
  }
}
