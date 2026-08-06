import { describe, expect, it } from "vitest";
import { formatCollabInvitationV2, parseCollabInvitationV2 } from "./collab-invitation-v2";

const valid = { version: 2 as const, deployment: "https://collab.example/", projectInstanceId: "project_abcdefghijklmnop", guestSecret: "A".repeat(43), permission: "write" as const };

describe("versioned v2 collaboration invitations", () => {
  it("round trips the deployment, identity, permission, and guest secret", () => {
    expect(parseCollabInvitationV2(formatCollabInvitationV2(valid))).toEqual(valid);
    expect(parseCollabInvitationV2(formatCollabInvitationV2({ ...valid, projectName: "Attention Paper" }))?.projectName).toBe("Attention Paper");
  });

  it("does not claim v1 invitations and rejects host secrets, weak identities, and weak secrets", () => {
    expect(parseCollabInvitationV2("LT-ABCDEF token@collab.example")).toBeNull();
    for (const payload of [
      { ...valid, projectInstanceId: "short" },
      { ...valid, guestSecret: "weak" },
      { ...valid, deployment: "http://collab.example/" },
      { ...valid, hostSecret: "must-never-appear" },
      { ...valid, projectName: "x".repeat(81) },
    ]) expect(() => formatCollabInvitationV2(payload as typeof valid)).toThrow();
  });
});
