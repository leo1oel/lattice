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

  it("keeps the host credential when the same machine also joins the room as a guest", () => {
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-1", host, credentialRef: "cred-host", permission: "host", title: "Paper", projectRoot: "/paper", lastUsed: 1 });
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-1", host, credentialRef: "cred-guest", permission: "write", title: "Paper", projectRoot: "/shares/paper", lastUsed: 9 });
    const [record] = loadCollabProjectsV2();
    // The host credential is the only thing that can close the room, so a guest
    // join must not overwrite it — but the row still sorts as just used.
    expect(record.permission).toBe("host");
    expect(record.credentialRef).toBe("cred-host");
    expect(record.projectRoot).toBe("/paper");
    expect(record.lastUsed).toBe(9);
    expect(loadCollabProjectsV2()).toHaveLength(1);
  });

  it("still updates a room the user only ever joined", () => {
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-2", host, credentialRef: "cred-a", permission: "write", title: "Paper", projectRoot: "/a", lastUsed: 1 });
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-2", host, credentialRef: "cred-b", permission: "read", title: "Renamed", projectRoot: "/b", lastUsed: 2 });
    expect(loadCollabProjectsV2()[0]).toMatchObject({ permission: "read", credentialRef: "cred-b", title: "Renamed", projectRoot: "/b" });
  });

  it("lets the host record be re-established after the room is forgotten", () => {
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-3", host, credentialRef: "cred-guest", permission: "write", title: "Paper", projectRoot: "/a", lastUsed: 1 });
    rememberCollabProjectV2({ version: 2, projectInstanceId: "project-3", host, credentialRef: "cred-host", permission: "host", title: "Paper", projectRoot: "/a", lastUsed: 2 });
    expect(loadCollabProjectsV2()[0]).toMatchObject({ permission: "host", credentialRef: "cred-host" });
  });

  it("sorts by stable creation time instead of moving a rejoined room to the top", () => {
    rememberCollabProjectV2({ version: 2, projectInstanceId: "older", host, credentialRef: "cred-old", permission: "host", title: "Older", projectRoot: "/old", createdAt: 10, lastUsed: 10 });
    rememberCollabProjectV2({ version: 2, projectInstanceId: "newer", host, credentialRef: "cred-new", permission: "host", title: "Newer", projectRoot: "/new", createdAt: 20, lastUsed: 20 });
    rememberCollabProjectV2({ version: 2, projectInstanceId: "older", host, credentialRef: "cred-old", permission: "host", title: "Older", projectRoot: "/old", createdAt: 30, lastUsed: 30 });

    const records = loadCollabProjectsV2();
    expect(records.map((record) => record.projectInstanceId)).toEqual(["newer", "older"]);
    expect(records.find((record) => record.projectInstanceId === "older")?.createdAt).toBe(10);
  });

  it("uses last-used as the creation time for records saved before creation time existed", () => {
    localStorage.setItem(PROJECTS_V2_KEY, JSON.stringify([
      { version: 2, projectInstanceId: "older", host, credentialRef: "cred-old", permission: "host", title: "Older", projectRoot: "/old", lastUsed: 10 },
      { version: 2, projectInstanceId: "newer", host, credentialRef: "cred-new", permission: "host", title: "Newer", projectRoot: "/new", lastUsed: 20 },
    ]));

    const records = loadCollabProjectsV2();
    expect(records.map((record) => [record.projectInstanceId, record.createdAt])).toEqual([
      ["newer", 20],
      ["older", 10],
    ]);
  });
});
