import { afterEach, describe, expect, it, vi } from "vitest";

const party = vi.hoisted(() => ({ response: undefined as Response | undefined }));
vi.mock("partyserver", async (importOriginal) => ({
  ...await importOriginal<typeof import("partyserver")>(),
  routePartykitRequest: vi.fn(async () => party.response),
}));

import worker from "../src/index";

const projectId = "project-abcdefghijkl";

function envReturning(value: Response | Error) {
  return {
    ProjectCoordinatorV2: {
      getByName: () => ({
        fetch: async () => {
          if (value instanceof Error) throw value;
          return value;
        },
      }),
    },
  } as any;
}

function captureLog() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return { spy, entry: () => JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown> };
}

afterEach(() => {
  party.response = undefined;
  vi.restoreAllMocks();
});

describe("worker completion logging", () => {
  it("preserves valid frontend correlation ids and returns the request id", async () => {
    const { entry } = captureLog();
    const operationId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const response = await worker.fetch(new Request(`https://worker/v2/projects/${projectId}/catalog`, {
      headers: { "x-lattice-operation-id": operationId, "x-lattice-request-id": requestId },
    }), envReturning(new Response("ok")));

    expect(entry()).toMatchObject({ operation_id: operationId, request_id: requestId });
    expect(response.headers.get("x-lattice-request-id")).toBe(requestId);
  });

  it("rejects malformed diagnostic headers", async () => {
    const { entry } = captureLog();
    const response = await worker.fetch(new Request(`https://worker/v2/projects/${projectId}/catalog`, {
      headers: { "x-lattice-request-id": "not-a-uuid" },
    }), envReturning(new Response("unreachable")));

    expect(response.status).toBe(400);
    expect(entry().request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs one bounded canonical success event", async () => {
    const { spy, entry } = captureLog();
    const response = await worker.fetch(new Request(`https://worker/v2/projects/${projectId}/catalog?credential=query-secret`, {
      headers: { authorization: "Bearer authorization-secret" },
    }), envReturning(new Response("ok", { status: 200 })));

    expect(await response.text()).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ service: "collab-server", event: "request_completed", method: "GET", route: "/v2/projects/:projectId/coordinator", status_code: 200, outcome: "success" });
    expect(entry().request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry().duration_ms).toEqual(expect.any(Number));
    expect(entry()).toMatchObject({ schema_version: 1, timestamp: expect.any(String) });
    expect(spy.mock.calls.flat().join(" ")).not.toMatch(/query-secret|authorization-secret/);
  });

  it.each([400, 503])("classifies an HTTP %i response as a failure", async (status) => {
    const { spy, entry } = captureLog();
    const response = await worker.fetch(new Request(`https://worker/v2/projects/${projectId}/catalog`), envReturning(new Response("typed", { status })));

    expect(response.status).toBe(status);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ status_code: status, outcome: "error" });
  });

  it("logs a bounded exception type once and rethrows the original error", async () => {
    const { spy, entry } = captureLog();
    const error = new Error("raw-private-error-message");
    const promise = worker.fetch(new Request(`https://worker/v2/projects/${projectId}/catalog`), envReturning(error));

    await expect(promise).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ status_code: 500, outcome: "error", error_type: "Error" });
    expect(spy.mock.calls.flat().join(" ")).not.toContain(error.message);
  });

  it("returns the original WebSocket response and never logs its ticket", async () => {
    const { spy, entry } = captureLog();
    const pair = new WebSocketPair();
    const upgrade = new Response(null, { status: 101, webSocket: pair[0] });
    party.response = upgrade;
    const ticket = "socket-ticket-private-value";

    const response = await worker.fetch(new Request(`https://worker/parties/text-file-v2/room-private?ticket=${ticket}`, {
      headers: { upgrade: "websocket", authorization: "Bearer websocket-auth-private" },
    }), {} as any);

    expect(response).toBe(upgrade);
    expect(response.webSocket).toBe(pair[0]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ route: "/parties/:party/:room", status_code: 101, outcome: "success" });
    expect(spy.mock.calls.flat().join(" ")).not.toMatch(/socket-ticket-private-value|websocket-auth-private|room-private/);
  });

  it("redacts binary tickets embedded in paths", async () => {
    const { spy, entry } = captureLog();
    const ticket = "binary-ticket-private-value";
    const response = await worker.fetch(new Request(`https://worker/v2/projects/${projectId}/binary/uploads/${ticket}`), {} as any);

    expect(response.status).toBe(405);
    expect(entry()).toMatchObject({ route: "/v2/projects/:projectId/binary/uploads/:ticket", status_code: 405, outcome: "error" });
    expect(spy.mock.calls.flat().join(" ")).not.toContain(ticket);
  });

});
