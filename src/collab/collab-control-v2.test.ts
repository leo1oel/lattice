import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Import the client fresh, after `fetch` is stubbed, so it sees this test's env
 * (vitest.config opts the build into sharing unless a test unstubs it).
 */
async function controlClient(fetcher: unknown, deployment = "https://collab.example", project = "project") {
  vi.stubGlobal("fetch", fetcher);
  const { CollabControlV2Client } = await import("./collab-control-v2");
  return new CollabControlV2Client(deployment, project, "secret");
}

describe("CollabControlV2Client", () => {
  it("makes no requests without the sharing build opt-in", async () => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", undefined);
    const fetcher = vi.fn();
    await expect((await controlClient(fetcher)).catalog()).rejects.toThrow("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("localizes exhausted service quota while preserving the server code", async () => {
    const { activateAppLocale } = await import("../i18n");
    const { CollabControlErrorV2 } = await import("./collab-control-v2");
    await activateAppLocale("zh-CN");
    const error = new CollabControlErrorV2(503, { error: "collab_quota_exceeded", message: "Server quota exceeded" });
    expect(error.message).toContain("共享服务今日请求额度已用完");
    expect(error.body.error).toBe("collab_quota_exceeded");
    expect(new CollabControlErrorV2(503, { error: "other", message: "Other failure" }).message).toBe("Other failure");
  });

  it("routes authenticated requests and validates catalog responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: 2, projectInstanceId: "project/id", lifecycle: "live", catalogRevision: 0,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files: [],
    }), { headers: { "content-type": "application/json" } }));
    await (await controlClient(fetch, "https://collab.example/", "project/id")).catalog();
    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("x-lattice-operation-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("x-lattice-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fails closed on malformed server catalogs", async () => {
    const client = await controlClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({ protocol: 2, files: [] }))));
    await expect(client.catalog()).rejects.toThrow("Invalid v2 catalog response");
  });

  it("keeps an explicit presence leave alive while the app window closes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ protocol: 2, presence: {} })));
    await (await controlClient(fetch)).presence({ instanceId: "instance", name: "Ada", color: "#123456", path: "paper.md", leave: true });
    expect(fetch).toHaveBeenCalledWith("https://collab.example/v2/projects/project/presence", expect.objectContaining({ keepalive: true }));
  });
});
