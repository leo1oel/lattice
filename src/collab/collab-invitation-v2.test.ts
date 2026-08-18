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

  it("carries a plain-HTTP deployment only when the host is local, so `wrangler dev` shares can be invited", () => {
    for (const deployment of ["http://localhost:8787/", "http://127.0.0.1:8787/", "http://192.168.1.20:8787/"]) {
      expect(parseCollabInvitationV2(formatCollabInvitationV2({ ...valid, deployment }))?.deployment).toBe(deployment);
    }
    for (const deployment of ["http://collab.example/", "http://localhost.evil.example/"]) {
      expect(() => formatCollabInvitationV2({ ...valid, deployment })).toThrow();
    }
  });
});
