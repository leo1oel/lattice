import { afterEach, describe, expect, it } from "vitest";
import { loadCollabProjectsV2, PROJECTS_V2_KEY, rememberCollabProjectV2 } from "./collab-rooms";

afterEach(() => localStorage.clear());

const host = "lattice-collab.example.workers.dev";

describe("v2 project memory", () => {
  it("persists only a non-secret credential reference", () => {
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-1", host, credentialRef: "native:key-1", permission: "host", title: "New", projectRoot: "/a", lastUsed: 2 });
    expect(loadCollabProjectsV2()[0].credentialRef).toBe("native:key-1");
    expect(localStorage.getItem(PROJECTS_V2_KEY)).not.toContain("secret");
  });

  it("does not accept legacy plaintext credential fields as a persisted credential", () => {
    localStorage.setItem(PROJECTS_V2_KEY, JSON.stringify([{ version: 2, projectInstanceId: "p", host, credential: "plaintext-secret", permission: "host" }]));
    expect(loadCollabProjectsV2()[0]).not.toHaveProperty("credentialRef");
  });
});
