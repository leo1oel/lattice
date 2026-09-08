import { invoke } from "@tauri-apps/api/core";
import { addAppLog } from "./app-log-store";

export type DiagnosticOperationContext = { operationId: string; requestId?: string };
export type DiagnosticContext = { operation_id: string; request_id: string };

function logCompletion(operation: string, context: DiagnosticContext, started: number, outcome: "success" | "error", error?: unknown, parentRequestId?: string, status?: number) {
  try {
    addAppLog({
      level: outcome === "success" ? "success" : "error",
      source: "Diagnostics",
      title: `${operation} request ${outcome}`,
      detail: "",
      context: {
        operation_id: context.operation_id,
        operation,
        phase: "completed",
        outcome,
        duration_ms: Math.round(performance.now() - started),
        error_type: error instanceof Error ? error.name : error === undefined ? undefined : "Error",
        request_id: context.request_id,
        parent_request_id: parentRequestId,
        metrics: status === undefined ? undefined : { status_code: status },
      },
      toast: false,
    });
  } catch {
    // Diagnostics must not turn a successful write into a failure/retry or
    // replace the original application exception when the log sink is broken.
  }
}

export async function diagnosticInvoke<T>(command: string, args: Record<string, unknown>, parent: DiagnosticOperationContext): Promise<T> {
  const context = { operation_id: parent.operationId, request_id: crypto.randomUUID() };
  const started = performance.now();
  try {
    const result = await invoke<T>(command, { ...args, diagnosticContext: context });
    logCompletion(command, context, started, "success", undefined, parent.requestId);
    return result;
  } catch (error) {
    logCompletion(command, context, started, "error", error, parent.requestId);
    throw error;
  }
}

export async function diagnosticFetch(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit | undefined, operation: string, parent?: DiagnosticOperationContext): Promise<Response> {
  const context = { operation_id: parent?.operationId ?? crypto.randomUUID(), request_id: crypto.randomUUID() };
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-lattice-operation-id", context.operation_id);
  headers.set("x-lattice-request-id", context.request_id);
  const started = performance.now();
  try {
    const response = await fetcher(input, { ...init, headers });
    logCompletion(operation, context, started, response.ok ? "success" : "error", undefined, parent?.requestId, response.status);
    return response;
  } catch (error) {
    logCompletion(operation, context, started, "error", error, parent?.requestId);
    throw error;
  }
}
