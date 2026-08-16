import { beforeEach, describe, expect, it } from "vitest";
import { MemoryCollabCredentialStore } from "./collab-credentials";
import { formatCollabInvitationV2 } from "./collab-invitation-v2";
import { acceptCollabInvitationV2 } from "./collab-join-v2";
import { loadCollabProjectsV2 } from "./collab-rooms";

describe("acceptCollabInvitationV2", () => {
  beforeEach(() => localStorage.clear());
  it("moves the guest secret into the credential store and remembers only its reference", async () => {
    const secret = "A".repeat(43);
    const raw = formatCollabInvitationV2({ version: 2, deployment: "https://collab.example/", projectInstanceId: "project_abcdefghijklmnop", guestSecret: secret, permission: "read" });
    const store = new MemoryCollabCredentialStore();
    const record = await acceptCollabInvitationV2(raw, store, { now: 7 });
    expect(record?.credentialRef).toMatch(/^cred_/);
    expect(await store.get(record!.credentialRef!, record!.projectInstanceId, record!.host)).toBe(secret);
    expect(record).toMatchObject({ createdAt: 7, lastUsed: 7 });
    expect(JSON.stringify(loadCollabProjectsV2())).not.toContain(secret);
    expect(localStorage.getItem("lattice.collab.projects.v2")).not.toContain(secret);
  });
});
