import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CollabControlV2Client", () => {
  it("routes authenticated requests and validates catalog responses", async () => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: 2, projectInstanceId: "project/id", lifecycle: "live", catalogRevision: 0,
      snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files: [],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const { CollabControlV2Client } = await import("./collab-control-v2");
    await new CollabControlV2Client("https://collab.example/", "project/id", "secret").catalog();
    expect(fetch).toHaveBeenCalledWith("https://collab.example/v2/projects/project%2Fid/catalog", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });

  it("fails closed on malformed server catalogs", async () => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ protocol: 2, files: [] }))));
    const { CollabControlV2Client } = await import("./collab-control-v2");
    await expect(new CollabControlV2Client("https://collab.example", "project", "secret").catalog()).rejects.toThrow("Invalid v2 catalog response");
  });

  it("keeps an explicit presence leave alive while the app window closes", async () => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", "true");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ protocol: 2, presence: {} })));
    vi.stubGlobal("fetch", fetch);
    const { CollabControlV2Client } = await import("./collab-control-v2");
    await new CollabControlV2Client("https://collab.example", "project", "secret").presence({
      instanceId: "instance",
      name: "Ada",
      color: "#123456",
      path: "paper.md",
      leave: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://collab.example/v2/projects/project/presence",
      expect.objectContaining({ keepalive: true }),
    );
  });
});
