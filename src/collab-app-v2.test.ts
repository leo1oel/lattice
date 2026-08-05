import { describe, expect, it, vi } from "vitest";
import { collabV2Inventory, parsePreferredCollabInvitation, requireRememberedV2Credential, shouldCreateCollabV2 } from "./collab-app-v2";
import { MemoryCollabCredentialStore } from "./collab-credentials";
import { formatCollabInvitationV2 } from "./collab-invitation-v2";

describe("App v2 collaboration routing", () => {
  it("requires both creation rollout flags", () => {
    const policy = { allowCreateV2: true, preferV2ForNewProjects: true, emergencyDisableReads: false, emergencyDisableWrites: false };
    expect(shouldCreateCollabV2(policy)).toBe(true);
    expect(shouldCreateCollabV2({ ...policy, preferV2ForNewProjects: false })).toBe(false);
  });

  it("reports a missing remembered credential without deleting anything", async () => {
    const store = new MemoryCollabCredentialStore(); const deleteSpy = vi.spyOn(store, "delete");
    await expect(requireRememberedV2Credential({ version: 2, projectInstanceId: "project_12345678", host: "https://sync.example", credentialRef: "missing", permission: "write", title: "Paper", projectRoot: null, lastUsed: 1 }, store)).rejects.toThrow("kept");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("recognizes a v2 invitation before legacy routing", () => {
    const raw = formatCollabInvitationV2({ version: 2, deployment: "https://example.com/", projectInstanceId: "project_12345678", guestSecret: "a".repeat(43), permission: "write" });
    expect(parsePreferredCollabInvitation(raw)?.projectInstanceId).toBe("project_12345678");
  });

  it("recursively inventories native text kinds and treats unknown files as binary", () => {
    const leaf = (path: string, contentKind?: "text" | "binary") => ({ name: path, path, kind: "file", contentKind, children: [] });
    const files = [{ name: "nested", path: "nested", kind: "directory", contentKind: "directory" as const, children: [leaf("nested/a.md", "text"), leaf("nested/a.txt", "text"), leaf("nested/a.json", "text"), leaf("nested/data.unknown")] }];
    expect(collabV2Inventory(files)).toEqual([
      { path: "nested/a.md", kind: "text" }, { path: "nested/a.txt", kind: "text" },
      { path: "nested/a.json", kind: "text" }, { path: "nested/data.unknown", kind: "binary" },
    ]);
  });
});
