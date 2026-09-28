import { routePartykitRequest } from "partyserver";
import { isBoundId, parseTextFileV2RoomName } from "../../protocol/collab-v2";
import { version } from "../package.json";
import { downloadBinary, importText, uploadBinary } from "./binary-transfer";
import type { ProjectCoordinatorV2 } from "./project-coordinator-v2";
import { json, typedError } from "./runtime";
import type { TextFileV2 } from "./text-file-v2";
export { ProjectCoordinatorV2 } from "./project-coordinator-v2";
export { TextFileV2 } from "./text-file-v2";

export type Env = {
  ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2>;
  TextFileV2: DurableObjectNamespace<TextFileV2>;
  BinaryObjects: R2Bucket;
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "authorization, content-length, content-type, x-content-sha256, x-document-epoch, x-operation-id, x-lattice-operation-id, x-lattice-request-id",
  "access-control-expose-headers": "x-lattice-request-id",
  "access-control-max-age": "86400",
} as const;

type ProjectHandler = (request: Request, env: Env, projectInstanceId: string, param: string) => Promise<Response>;

/**
 * First match wins. `name` is what the completion log records instead of the
 * raw path, which can embed a ticket. Routes with a handler are project routes:
 * group 1 is the project id and group 2 the handler's parameter.
 */
const ROUTES: Array<{ pattern: RegExp; name: string; handle?: ProjectHandler }> = [
  { pattern: /^\/v2\/projects\/([^/]+)\/binary\/uploads\/([^/]+)$/, name: "/v2/projects/:projectId/binary/uploads/:ticket", handle: uploadBinary },
  { pattern: /^\/v2\/projects\/([^/]+)\/binary\/downloads\/([^/]+)$/, name: "/v2/projects/:projectId/binary/downloads/:ticket", handle: downloadBinary },
  { pattern: /^\/v2\/projects\/([^/]+)\/text\/imports\/([^/]+)$/, name: "/v2/projects/:projectId/text/imports/:fileId", handle: importText },
  { pattern: /^\/v2\/projects\/([^/]+)(?:\/|$)/, name: "/v2/projects/:projectId/coordinator", handle: (request, env, projectInstanceId) => env.ProjectCoordinatorV2.getByName(projectInstanceId).fetch(request) },
  { pattern: /^\/parties\/[^/]+\/[^/]+(?:\/|$)/, name: "/parties/:party/:room" },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = performance.now();
    const suppliedOperationId = request.headers.get("x-lattice-operation-id");
    const suppliedRequestId = request.headers.get("x-lattice-request-id");
    const operationId = suppliedOperationId && isUuid(suppliedOperationId) ? suppliedOperationId : crypto.randomUUID();
    const requestId = suppliedRequestId && isUuid(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
    const corsWithRequestId = { ...CORS_HEADERS, "x-lattice-request-id": requestId };
    let statusCode = 500;
    let errorType: string | undefined;
    let route = "other";
    try {
      let response: Response;
      if ((suppliedOperationId && !isUuid(suppliedOperationId)) || (suppliedRequestId && !isUuid(suppliedRequestId))) {
        response = withHeaders(new Response("Invalid diagnostic context", { status: 400 }), corsWithRequestId);
      } else {
        const { pathname } = new URL(request.url);
        const matched = ROUTES.find((candidate) => candidate.pattern.test(pathname));
        route = matched?.name ?? "other";
        response = matched?.handle
          ? withHeaders(await routeProject(request, env, matched.handle, matched.pattern.exec(pathname)!), corsWithRequestId)
          : withHeaders(await routeParty(request, env), { "x-lattice-request-id": requestId });
      }
      statusCode = response.status;
      return response;
    } catch (error) {
      errorType = boundedErrorType(error);
      // Platform exceptions otherwise become Cloudflare 1101 responses without
      // CORS headers, hiding the actual failure behind WebKit's "Load failed".
      const quotaExceeded = error instanceof Error
        && error.message.includes("Exceeded allowed volume of requests in Durable Objects free tier");
      statusCode = quotaExceeded ? 503 : 500;
      return withHeaders(json(quotaExceeded
        ? { error: "collab_quota_exceeded", message: "The collaboration service has reached its daily request limit. Try again after 00:00 UTC or ask the service owner to upgrade the Workers plan." }
        : { error: "internal_error", message: "Collaboration service failed. Please try again later." }, statusCode), corsWithRequestId);
    } finally {
      console.log(JSON.stringify({
        schema_version: 1, timestamp: new Date().toISOString(), request_id: requestId, operation_id: operationId,
        service: "collab-server", component: "collab.worker", version, event: "request_completed", operation: route, phase: "completed",
        method: request.method, route, status_code: statusCode, outcome: statusCode >= 400 ? "error" : "success",
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)), ...(errorType ? { error_type: errorType } : {}),
      }));
    }
  },
} satisfies ExportedHandler<Env>;

async function routeProject(request: Request, env: Env, handle: ProjectHandler, match: RegExpExecArray): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  const projectInstanceId = decodeURIComponent(match[1]);
  if (!isBoundId(projectInstanceId)) return new Response("Invalid projectInstanceId", { status: 400 });
  return await handle(request, env, projectInstanceId, decodeURIComponent(match[2] ?? ""));
}

async function routeParty(request: Request, env: Env): Promise<Response> {
  return (await routePartykitRequest(request, env as never, {
    onBeforeConnect: async (incoming, lobby) => {
      if (lobby.className !== "TextFileV2") return;
      const identity = parseTextFileV2RoomName(lobby.name);
      if (!identity) return typedError(400, "invalid_room");
      const sanitized = new URL(incoming.url);
      const ticket = sanitized.searchParams.get("ticket") ?? "";
      sanitized.searchParams.delete("ticket");
      if (!ticket) return typedError(401, "ticket_required");
      const claims = await env.ProjectCoordinatorV2.getByName(identity.projectInstanceId).consumeSocketTicket(ticket, "file", identity.fileId, identity.documentEpoch);
      if (!claims || claims.projectInstanceId !== identity.projectInstanceId || claims.fileId !== identity.fileId || claims.documentEpoch !== identity.documentEpoch) return typedError(403, "invalid_ticket");
      // The room trusts these claim headers because the ticket was consumed here; they overwrite anything the client sent.
      const headers = new Headers(incoming.headers);
      const claimHeaders = { project: claims.projectInstanceId, file: claims.fileId, epoch: claims.documentEpoch, grant: claims.grantId, permission: claims.permission, "grant-epoch": claims.grantEpoch, "authority-epoch": claims.projectAuthorityEpoch };
      for (const [name, value] of Object.entries(claimHeaders)) headers.set(`x-lattice-${name}`, String(value));
      return new Request(sanitized, { method: incoming.method, headers });
    },
  })) ?? new Response("Lattice collab server", { status: 200 });
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  if (response.webSocket) return response;
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function boundedErrorType(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof DOMException) return "DOMException";
  if (error instanceof Error) return "Error";
  return "unknown";
}
