import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { addAppLog } from "./app-log-store";
import { diagnosticFetch, diagnosticInvoke } from "./diagnostic-request";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./app-log-store", () => ({ addAppLog: vi.fn(() => ({ id: "log" })) }));

beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(addAppLog).mockClear(); });

describe("diagnostic request correlation", () => {
  it("preserves tuple and Request headers and never lets a broken logger fail a request", async () => {
    const fetcher = vi.fn(async () => new Response());
    const parent = { operationId: crypto.randomUUID(), requestId: crypto.randomUUID() };
    await diagnosticFetch(fetcher, "https://collab", { headers: [["x-operation-id", "protocol-id"], ["Authorization", "Bearer secret"]] }, "catalog", parent);
    expect(addAppLog).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ parent_request_id: parent.requestId }) }));
    vi.mocked(addAppLog).mockImplementationOnce(() => { throw new Error("sink failed"); });
    await expect(diagnosticFetch(fetcher, new Request("https://collab", { headers: { Authorization: "Bearer secret" } }), undefined, "catalog", parent)).resolves.toBeInstanceOf(Response);
    const calls = fetcher.mock.calls as unknown as [RequestInfo, RequestInit][];
    expect(new Headers(calls[0][1].headers).get("x-operation-id")).toBe("protocol-id");
    for (const [, init] of calls) expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret");
  });

  it("passes parent and child UUIDs through IPC", async () => {
    vi.mocked(invoke).mockResolvedValue("ok");
    const operationId = crypto.randomUUID();
    await diagnosticInvoke("build_project", { force: false }, { operationId });
    expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      diagnosticContext: { operation_id: operationId, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    }));
  });

  it("keeps a logical operation id while assigning each retry a request id", async () => {
    const calls: Headers[] = [];
    const fetcher = vi.fn(async (_input, init) => { calls.push(new Headers(init?.headers)); return new Response(); }) as typeof fetch;
    const parent = { operationId: crypto.randomUUID() };
    await diagnosticFetch(fetcher, "https://collab", undefined, "catalog", parent);
    await diagnosticFetch(fetcher, "https://collab", undefined, "catalog", parent);
    expect(calls.map((headers) => headers.get("x-lattice-operation-id"))).toEqual([parent.operationId, parent.operationId]);
    expect(calls[0].get("x-lattice-request-id")).not.toBe(calls[1].get("x-lattice-request-id"));
  });
});
