import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogV2 } from "../../protocol/collab-v2";
import { MemoryCollabCredentialStore } from "./collab-credentials";
import { createProjectV2, putTextFileV2, type ImportFileV2, type ImportV2Options } from "./collab-import-v2";

const policy = { allowCreateV2: true, emergencyDisableWrites: false, emergencyDisableReads: false };
const mainTexSource = { inventory: async () => [{ path: "main.tex", kind: "text" as const }], read: async () => new TextEncoder().encode("Hello") };

afterEach(() => vi.unstubAllEnvs());

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Import options with a fresh credential store; `fetch` and `source` are what each test is about. */
function importOptions(overrides: Pick<ImportV2Options, "fetch" | "source"> & Partial<ImportV2Options>): ImportV2Options {
  return { deployment: "https://collab.example", credentialStore: new MemoryCollabCredentialStore(), policy, onRecord: async () => {}, ...overrides };
}

/**
 * An in-memory coordinator for a whole import: bootstrap seeds an importing
 * catalog from the manifest, and each text import or binary commit makes its
 * file live. Uploads take 5 ms so concurrent ones overlap and `maxUploads`
 * measures the concurrency bound.
 */
function importServer() {
  const state = { catalog: undefined as CatalogV2 | undefined, manifest: [] as Omit<ImportFileV2, "bytes" | "contentType">[], catalogRequests: 0, activeUploads: 0, maxUploads: 0 };
  const ticketFiles = new Map<string, string>();
  const upload = async () => {
    state.activeUploads += 1; state.maxUploads = Math.max(state.maxUploads, state.activeUploads);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.activeUploads -= 1;
  };
  const goLive = (fileId: string, patch: object = {}) => {
    const source = state.manifest.find((file) => file.fileId === fileId)!;
    Object.assign(state.catalog!.files.find((entry) => entry.fileId === fileId)!, { state: "live", size: source.size, hash: source.hash, ...patch });
    state.catalog!.catalogRevision += 1;
  };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/catalog")) {
      state.catalogRequests += 1;
      return state.catalog ? json(state.catalog) : json({ error: "not_found" }, 404);
    }
    if (url.endsWith("/bootstrap")) {
      const body = JSON.parse(String(init?.body)); state.manifest = body.importManifest;
      state.catalog = { protocol: 2, projectInstanceId: body.projectInstanceId, lifecycle: "importing", catalogRevision: 0, snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files: state.manifest.map((file) => ({ fileId: file.fileId, path: file.path, kind: file.kind, state: "initializing", documentEpoch: 1 })) };
      return json(state.catalog, 201);
    }
    if (url.includes("/text/imports/")) { await upload(); goLive(decodeURIComponent(url.split("/").at(-1)!)); return json({ status: "created" }, 201); }
    if (url.endsWith("/binary/upload-tickets")) {
      const { fileId } = JSON.parse(String(init?.body)); ticketFiles.set(`ticket-${fileId}`, fileId);
      return json({ ticket: `ticket-${fileId}` });
    }
    if (url.includes("/binary/uploads/")) { await upload(); return new Response(null, { status: 201 }); }
    if (url.endsWith("/binary/commit")) { goLive(ticketFiles.get(JSON.parse(String(init?.body)).ticket)!, { contentRevision: 1 }); return json({ status: "complete" }); }
    if (url.endsWith("/import-finalize")) { state.catalog!.lifecycle = "live"; state.catalog!.catalogRevision += 1; return json({ status: "complete" }); }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { state, fetch: fetcher as typeof fetcher & typeof fetch };
}

describe("createProjectV2", () => {
  it("does not read files or create credentials when sharing is disabled", async () => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", undefined);
    const fetcher = vi.fn();
    const source = { inventory: vi.fn(), read: vi.fn() };
    const options = importOptions({ fetch: fetcher, source, onRecord: vi.fn() });
    const put = vi.spyOn(options.credentialStore, "put");
    await expect(createProjectV2(options)).rejects.toThrow("v2_creation_disabled");
    expect(source.inventory).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([503, 401, "network"])("does not bootstrap after a catalog failure (%s)", async (failure) => {
    const fetcher = vi.fn(async () => {
      if (failure === "network") throw new TypeError("Load failed");
      return json({ error: "service_unavailable", message: "Service unavailable" }, failure as number);
    });
    const onRecord = vi.fn();
    await expect(createProjectV2(importOptions({
      fetch: fetcher, onRecord, source: { inventory: async () => [], read: async () => new Uint8Array() },
    }))).rejects.toThrow(failure === "network" ? "Load failed" : "Service unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("reads and uploads text files concurrently without refetching the catalog after every file", async () => {
    const paths = ["data.lattice-sheet", ...Array.from({ length: 11 }, (_, index) => `chapter-${index}.md`)];
    const server = importServer();
    let activeReads = 0; let maxReads = 0;
    const preparationProgress: Array<[number, number]> = []; const progress: Array<[number, number]> = [];

    await createProjectV2(importOptions({
      projectName: "Attention Paper",
      projectInstanceId: "project_parallel_import",
      idFactory: () => "operation_parallel_import",
      fetch: server.fetch,
      source: {
        inventory: async () => paths.map((path) => ({ path, kind: "text" as const })),
        read: async (path) => {
          activeReads += 1; maxReads = Math.max(maxReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeReads -= 1; return new TextEncoder().encode(path);
        },
      },
      onPrepareProgress: (completed, total) => preparationProgress.push([completed, total]),
      onProgress: (completed, total) => progress.push([completed, total]),
    }));

    expect(maxReads).toBe(8);
    expect(JSON.parse(String(server.fetch.mock.calls.find(([input]) => String(input).endsWith("/bootstrap"))?.[1]?.body)).projectName).toBe("Attention Paper");
    expect(server.state.manifest.find((file) => file.path === "data.lattice-sheet")?.kind).toBe("spreadsheet");
    expect(server.state.maxUploads).toBe(8);
    expect(server.state.catalogRequests).toBe(3);
    expect(preparationProgress.at(-1)).toEqual([paths.length, paths.length]);
    expect(progress.at(-1)).toEqual([paths.length, paths.length]);
  });

  it("uploads binary files with bounded concurrency and refetches the catalog once after the batch", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `figure-${index}.png`);
    const server = importServer();
    const progress: Array<[number, number]> = [];

    await createProjectV2(importOptions({
      projectInstanceId: "project_parallel_binary_import",
      idFactory: () => "operation_parallel_binary_import",
      fetch: server.fetch,
      source: {
        inventory: async () => paths.map((path) => ({ path, kind: "binary" as const })),
        read: async (path) => new TextEncoder().encode(path),
      },
      onProgress: (completed, total) => progress.push([completed, total]),
    }));

    expect(server.state.maxUploads).toBe(8);
    expect(server.state.catalogRequests).toBe(3);
    expect(progress.at(-1)).toEqual([paths.length, paths.length]);
  });

  it("preserves the server error when project bootstrap is rejected", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/catalog")
      ? json({ error: "not_found" }, 404)
      : json({ error: "invalid_request", message: "Invalid import file kind" }, 400));

    await expect(createProjectV2(importOptions({
      projectName: "Attention Paper",
      projectInstanceId: "project_rejected_bootstrap",
      idFactory: () => "operation_rejected_bootstrap",
      fetch: fetcher as typeof fetch,
      source: mainTexSource,
    }))).rejects.toThrow("v2_bootstrap_failed: invalid_request: Invalid import file kind (400)");
  });

  it("preserves the diagnostic operation across resume attempts while generating new request IDs", async () => {
    const contexts: Array<{ operationId: string | null; requestId: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      contexts.push({ operationId: headers.get("x-lattice-operation-id"), requestId: headers.get("x-lattice-request-id") });
      return String(input).endsWith("/catalog")
        ? json({ error: "not_found" }, 404)
        : json({ error: "temporarily_unavailable" }, 503);
    });
    const options = importOptions({
      projectInstanceId: "project_resume_diagnostics",
      idFactory: () => "protocol_import_operation",
      fetch: fetcher as typeof fetch,
      source: mainTexSource,
    });
    let resume: NonNullable<ImportV2Options["resume"]>;
    try {
      await createProjectV2(options);
      throw new Error("Expected import to fail");
    } catch (error) {
      resume = (error as { resume: typeof resume }).resume;
    }
    await expect(createProjectV2({ ...options, resume })).rejects.toThrow("v2_bootstrap_failed");

    expect(resume.operationId).toBe("protocol_import_operation");
    expect(resume.diagnosticOperationId).not.toBe(resume.operationId);
    expect(new Set(contexts.map((context) => context.operationId))).toEqual(new Set([resume.diagnosticOperationId!]));
    expect(new Set(contexts.map((context) => context.requestId)).size).toBe(contexts.length);
  });

  it("preserves the server error when a durable text import is rejected", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ protocol: 2, error: "import_not_authorized" }, 403));
    await expect(putTextFileV2({
      fetch: fetcher,
      deployment: "https://collab.example",
      projectInstanceId: "project_parallel_import",
      credential: "secret",
      fileId: "comments",
      documentEpoch: 1,
      bytes: new TextEncoder().encode("[]"),
      operationId: "initialize_comments",
    })).rejects.toThrow("text_import_failed: import_not_authorized (403)");
  });
});
