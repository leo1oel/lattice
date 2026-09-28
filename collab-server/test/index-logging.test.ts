import { afterEach, describe, expect, it, vi } from "vitest";

const party = vi.hoisted(() => ({ response: undefined as Response | undefined }));
vi.mock("partyserver", async (importOriginal) => ({
  ...await importOriginal<typeof import("partyserver")>(),
  routePartykitRequest: vi.fn(async () => party.response),
}));

import worker from "../src/index";

const catalogUrl = "https://worker/v2/projects/project-abcdefghijkl/catalog";

/** Sends `url` through the Worker with a coordinator that answers every request with `value`, or throws it. */
function fetchVia(value: Response | Error, init?: RequestInit, url = catalogUrl) {
  const fetch = async () => { if (value instanceof Error) throw value; return value; };
  return worker.fetch(new Request(url, init), { ProjectCoordinatorV2: { getByName: () => ({ fetch }) } } as any);
}

function captureLog() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return { spy, entry: () => JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>, logged: () => spy.mock.calls.flat().join(" ") };
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
    const response = await fetchVia(new Response("ok"), { headers: { "x-lattice-operation-id": operationId, "x-lattice-request-id": requestId } });
    expect(entry()).toMatchObject({ operation_id: operationId, request_id: requestId });
    expect(response.headers.get("x-lattice-request-id")).toBe(requestId);
  });

  it("rejects malformed diagnostic headers", async () => {
    const { entry } = captureLog();
    const response = await fetchVia(new Response("unreachable"), { headers: { "x-lattice-request-id": "not-a-uuid" } });
    expect(response.status).toBe(400);
    expect(entry().request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs one bounded canonical success event", async () => {
    const { spy, entry, logged } = captureLog();
    const response = await fetchVia(new Response("ok", { status: 200 }), { headers: { authorization: "Bearer authorization-secret" } }, `${catalogUrl}?credential=query-secret`);
    expect(await response.text()).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ schema_version: 1, timestamp: expect.any(String), service: "collab-server", event: "request_completed", method: "GET", route: "/v2/projects/:projectId/coordinator", status_code: 200, outcome: "success" });
    expect(entry().request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry().duration_ms).toEqual(expect.any(Number));
    expect(logged()).not.toMatch(/query-secret|authorization-secret/);
  });

  it.each([400, 503])("classifies an HTTP %i response as a failure", async (status) => {
    const { spy, entry } = captureLog();
    expect((await fetchVia(new Response("typed", { status }))).status).toBe(status);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ status_code: status, outcome: "error" });
  });

  it.each([
    ["returns a CORS-readable error without exposing the original exception", "raw-private-error-message", 500, { error: "internal_error", message: "Collaboration service failed. Please try again later." }],
    ["reports exhausted Durable Object request quota through CORS instead of a platform 1101", "Exceeded allowed volume of requests in Durable Objects free tier.", 503, { error: "collab_quota_exceeded", message: "The collaboration service has reached its daily request limit. Try again after 00:00 UTC or ask the service owner to upgrade the Workers plan." }],
  ])("%s", async (_title, message, status, body) => {
    const { spy, entry, logged } = captureLog();
    const response = await fetchVia(new Error(message));
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-lattice-request-id")).toBe(entry().request_id);
    expect(await response.json()).toEqual(body);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ status_code: status, outcome: "error", error_type: "Error" });
    expect(logged()).not.toContain(message);
  });

  it("returns the original WebSocket response and never logs its ticket", async () => {
    const { spy, entry, logged } = captureLog();
    const pair = new WebSocketPair();
    party.response = new Response(null, { status: 101, webSocket: pair[0] });
    const response = await worker.fetch(new Request("https://worker/parties/text-file-v2/room-private?ticket=socket-ticket-private-value", {
      headers: { upgrade: "websocket", authorization: "Bearer websocket-auth-private" },
    }), {} as any);
    expect(response).toBe(party.response);
    expect(response.webSocket).toBe(pair[0]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ route: "/parties/:party/:room", status_code: 101, outcome: "success" });
    expect(logged()).not.toMatch(/socket-ticket-private-value|websocket-auth-private|room-private/);
  });

  it("redacts binary tickets embedded in paths", async () => {
    const { entry, logged } = captureLog();
    const response = await worker.fetch(new Request("https://worker/v2/projects/project-abcdefghijkl/binary/uploads/binary-ticket-private-value"), {} as any);
    expect(response.status).toBe(405);
    expect(entry()).toMatchObject({ route: "/v2/projects/:projectId/binary/uploads/:ticket", status_code: 405, outcome: "error" });
    expect(logged()).not.toContain("binary-ticket-private-value");
  });
});
