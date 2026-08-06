import { describe, expect, it, vi } from "vitest";
import type { CatalogV2 } from "../protocol/collab-v2";
import { MemoryCollabCredentialStore } from "./collab-credentials";
import { createProjectV2, putTextFileV2, type ImportFileV2 } from "./collab-import-v2";

const policy = { allowCreateV2: true, preferV2ForNewProjects: true, emergencyDisableWrites: false, emergencyDisableReads: false };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("createProjectV2", () => {
  it("reads and uploads text files concurrently without refetching the catalog after every file", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `chapter-${index}.md`);
    let activeReads = 0; let maxReads = 0; let activeUploads = 0; let maxUploads = 0; let catalogRequests = 0;
    let catalog: CatalogV2 | undefined;
    let manifest: Omit<ImportFileV2, "bytes" | "contentType">[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/catalog")) {
        catalogRequests += 1;
        return catalog ? json(catalog) : json({ error: "not_found" }, 404);
      }
      if (url.endsWith("/bootstrap")) {
        const body = JSON.parse(String(init?.body)); manifest = body.importManifest;
        catalog = { protocol: 2, projectInstanceId: body.projectInstanceId, lifecycle: "importing", catalogRevision: 0, snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files: manifest.map((file) => ({ fileId: file.fileId, path: file.path, kind: file.kind, state: "initializing", documentEpoch: 1 })) };
        return json(catalog, 201);
      }
      if (url.includes("/text/imports/")) {
        activeUploads += 1; maxUploads = Math.max(maxUploads, activeUploads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const fileId = decodeURIComponent(url.split("/").at(-1)!); const source = manifest.find((file) => file.fileId === fileId)!; const file = catalog!.files.find((entry) => entry.fileId === fileId)!;
        Object.assign(file, { state: "live", size: source.size, hash: source.hash }); catalog!.catalogRevision += 1; activeUploads -= 1;
        return json({ status: "created" }, 201);
      }
      if (url.endsWith("/import-finalize")) { catalog!.lifecycle = "live"; catalog!.catalogRevision += 1; return json({ status: "complete" }); }
      throw new Error(`Unexpected request: ${url}`);
    });
    const preparationProgress: Array<[number, number]> = []; const progress: Array<[number, number]> = [];

    await createProjectV2({
      deployment: "https://collab.example",
      projectName: "Attention Paper",
      projectInstanceId: "project_parallel_import",
      idFactory: () => "operation_parallel_import",
      credentialStore: new MemoryCollabCredentialStore(),
      fetch: fetcher as typeof fetch,
      policy,
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
      onRecord: async () => {},
    });

    expect(maxReads).toBe(8);
    expect(JSON.parse(String(fetcher.mock.calls.find(([input]) => String(input).endsWith("/bootstrap"))?.[1]?.body)).projectName).toBe("Attention Paper");
    expect(maxUploads).toBe(8);
    expect(catalogRequests).toBe(3);
    expect(preparationProgress.at(-1)).toEqual([paths.length, paths.length]);
    expect(progress.at(-1)).toEqual([paths.length, paths.length]);
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
