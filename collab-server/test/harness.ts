import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { sha256Hex } from "../../protocol/encoding";
import type { ProjectCoordinatorV2 } from "../src/project-coordinator-v2";
import type { TextFileV2 } from "../src/text-file-v2";

declare module "cloudflare:workers" {
  namespace Cloudflare { interface Env { ProjectCoordinatorV2: DurableObjectNamespace<ProjectCoordinatorV2>; TextFileV2: DurableObjectNamespace<TextFileV2>; BinaryObjects: R2Bucket } }
}

export const HOST_SECRET = "host-secret-with-at-least-thirty-two-bytes";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Serves `/v2/projects/...`: the Worker (`SELF`) or, bypassing it, a coordinator stub. */
type Target = { fetch(input: string, init?: RequestInit): Promise<Response> };
type RequestOptions = { body?: object; credential?: string | null; method?: string };

export const projectId = (label: string) => `${label}-${crypto.randomUUID()}`;

/** One control-plane request, as the host unless `credential` says otherwise (`null` sends none). */
export async function request(target: Target, id: string, path: string, { body, credential = HOST_SECRET, method }: RequestOptions = {}) {
  const response = await target.fetch(`https://test/v2/projects/${id}/${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, headers: response.headers, body: await response.json<any>().catch(() => undefined) };
}

/** A catalog operation under a fresh operation id; a text `create` gets an empty-file initializer unless the body has one. */
export function mutate(target: Target, id: string, action: string, revision: number, body: object = {}, credential = HOST_SECRET) {
  const initializer = action === "create" && (body as { kind?: string }).kind !== "binary"
    ? { initializer: { operationId: `initialize_${crypto.randomUUID()}`, size: 0, hash: EMPTY_SHA256 } }
    : {};
  return request(target, id, action, { credential, body: { operationId: crypto.randomUUID(), expectedCatalogRevision: revision, ...initializer, ...body } });
}

/**
 * Bootstraps a project through the Worker (or `direct`ly through its
 * coordinator) and, unless `finalize: false`, finalizes its manifest-less
 * import. `ready` then marks every file live as a completed import would, so
 * the catalog revision is 1 + the number of files.
 */
export async function createProject(label: string, { paths = [], kind = "text", finalize = true, ready = false, direct = false, name }: { paths?: string[]; kind?: "text" | "binary"; finalize?: boolean; ready?: boolean; direct?: boolean; name?: string } = {}) {
  const id = projectId(label);
  const stub = env.ProjectCoordinatorV2.getByName(id);
  const target: Target = direct ? stub : SELF;
  const bootstrap = await request(target, id, "bootstrap", { credential: null, body: { projectInstanceId: id, hostSecret: HOST_SECRET, paths, kind, ...(name ? { projectName: name } : {}) } });
  expect(bootstrap.status).toBe(201);
  if (finalize) await mutate(target, id, "import-finalize", 0);
  const files: Array<{ fileId: string }> = bootstrap.body.files;
  if (ready) for (const file of files) await stub.acknowledgeFileReady(file.fileId, 1);
  return {
    id, stub, files, fileId: files[0]?.fileId as string,
    call: (path: string, options?: RequestOptions) => request(target, id, path, options),
    mutate: (action: string, revision: number, body?: object, credential?: string) => mutate(target, id, action, revision, body, credential),
  };
}

/** A guest secret's salted hash, as the host registers it for a grant. */
export async function guestSecretHash(secret: string) {
  const salt = "A".repeat(43);
  return { salt, hash: await sha256Hex(`${salt}:${secret}`) };
}

export function storedValue<T = any>(stub: DurableObjectStub, key: string): Promise<T | undefined> {
  return runInDurableObject(stub, async (_instance, state) => state.storage.get<T>(key));
}

export const storedState = (stub: DurableObjectStub) => storedValue(stub, "coordinator:v2");

/** An upload ticket for `bytes` as a PDF into epoch 1 of a binary file; `claims` override any declared field. */
export async function uploadTicket(id: string, fileId: string, bytes: Uint8Array, claims: object = {}): Promise<{ ticket: string }> {
  const body = { fileId, documentEpoch: 1, declaredHash: await sha256Hex(bytes), declaredSize: bytes.length, contentType: "application/pdf", expectedCatalogRevision: 2, expectedContentRevision: 0, operationId: crypto.randomUUID(), ...claims };
  return (await request(SELF, id, "binary/upload-tickets", { body })).body;
}

export function putBinary(id: string, ticket: string, body: Uint8Array | ReadableStream, headers?: HeadersInit) {
  headers ??= { "content-type": "application/pdf", "content-length": String((body as Uint8Array).length) };
  return SELF.fetch(`https://test/v2/projects/${id}/binary/uploads/${ticket}`, { method: "PUT", headers, body });
}

/** The claim headers the Worker attaches to an authorized room upgrade. */
export function upgradeHeaders(id: string, fileId: string) {
  return { Upgrade: "websocket", "x-lattice-project": id, "x-lattice-file": fileId, "x-lattice-epoch": "1", "x-lattice-permission": "host" };
}
