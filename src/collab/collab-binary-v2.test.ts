import { describe, expect, it, vi } from "vitest";
import { CollabBinaryHttpError, CollabBinaryV2Client } from "./collab-binary-v2";

const bytes = new TextEncoder().encode("verified binary");
const hash = "86fd6fb55a10988213329d914da3f5fbbc213ee143b46148ed21b60d9454e3dc";
const reference = { fileId: "file-abcdefghijkl", documentEpoch: 1, contentRevision: 1, hash, size: bytes.length, contentType: "application/pdf" };

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

describe("CollabBinaryV2Client", () => {
  it("hashes, authenticates, and performs ticket, upload, commit in order with idempotent in-flight retry", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).endsWith("upload-tickets")) return json({ ticket: "ticket" });
      if (String(url).includes("/uploads/")) return new Response(null, { status: 201 });
      return json({ status: "complete", current: reference });
    }) as unknown as typeof fetch;
    const client = new CollabBinaryV2Client("https://collab", "project-abcdefghijkl", "secret", { fetch: fetcher, idFactory: () => "operation-fixed" });
    const first = client.replace(reference.fileId, 1, bytes, "application/pdf", 2, 0);
    const retry = client.replace(reference.fileId, 1, bytes, "application/pdf", 2, 0, undefined, "operation-fixed");
    expect(await first).toEqual(await retry);
    expect(calls.map(([url]) => url.split("/").at(-1))).toEqual(["upload-tickets", "ticket", "commit"]);
    const claimBody = JSON.parse(String(calls[0][1]?.body));
    expect(claimBody).toMatchObject({ declaredHash: hash, operationId: "operation-fixed" });
    expect(new Headers(calls[1][1]?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("returns both conflict sides and can subsequently request the loser", async () => {
    const conflict = { conflictId: "conflict", fileId: reference.fileId, createdAt: 1, winner: reference, loser: { ...reference, hash } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ ticket: "ticket" })).mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(json({ status: "conflict", current: reference, conflict }))
      .mockResolvedValueOnce(json({ ticket: "read", hash, size: bytes.length })).mockResolvedValueOnce(new Response(bytes));
    const client = new CollabBinaryV2Client("https://collab", "project-abcdefghijkl", "secret", { fetch: fetcher as typeof fetch });
    expect((await client.replace(reference.fileId, 1, bytes, "application/pdf", 2, 0, undefined, "operation1")).status).toBe("conflict");
    expect(Array.from(await client.download(reference.fileId, 1, "conflict"))).toEqual(Array.from(bytes));
    expect(JSON.parse(fetcher.mock.calls[3][1].body).conflictId).toBe("conflict");
  });

  it("fails closed before materialization on size, hash, and stale lease", async () => {
    let leaseChecks = 0;
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ticket: "read", hash, size: bytes.length + 1 })).mockResolvedValueOnce(new Response(bytes));
    const client = new CollabBinaryV2Client("https://collab", "project-abcdefghijkl", "secret", { fetch: fetcher as typeof fetch, checkWorkspaceLease: () => { leaseChecks += 1; } });
    await expect(client.download(reference.fileId, 1)).rejects.toThrow("integrity");
    expect(leaseChecks).toBeGreaterThan(0);
  });

  it("does not commit when the workspace switches after upload", async () => {
    let current = true;
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("upload-tickets")) return json({ ticket: "ticket" });
      if (String(url).includes("/uploads/")) { current = false; return new Response(null, { status: 201 }); }
      return json({ status: "complete", current: reference });
    }) as unknown as typeof fetch;
    const client = new CollabBinaryV2Client("https://collab", "project-abcdefghijkl", "secret", { fetch: fetcher, checkWorkspaceLease: () => { if (!current) throw new Error("lease expired"); } });
    await expect(client.replace(reference.fileId, 1, bytes, "application/pdf", 2, 0, undefined, "operation2")).rejects.toThrow("lease expired");
    expect(calls.some((url) => url.endsWith("/binary/commit"))).toBe(false);
  });

  it("classifies permanent and retryable HTTP failures", async () => {
    for (const [status, retryable] of [[403, false], [503, true]] as const) {
      const client = new CollabBinaryV2Client("https://collab", "project-abcdefghijkl", "secret", { fetch: vi.fn().mockResolvedValue(json({ error: "denied", message: "no" }, status)) as unknown as typeof fetch });
      const error = await client.download(reference.fileId, 1).catch((value) => value);
      expect(error).toBeInstanceOf(CollabBinaryHttpError);
      expect(error.retryable).toBe(retryable);
    }
  });
});
