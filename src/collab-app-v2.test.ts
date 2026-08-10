import { describe, expect, it, vi } from "vitest";
import {
  collabV2Inventory,
  mayApplyProjectRefreshV2,
  parsePreferredCollabInvitation,
  planRemoteCollabDeleteUiV2,
  readRememberedV2Credential,
  requireRememberedV2Credential,
  shouldCreateCollabV2,
} from "./collab-app-v2";
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

  it("keeps controller startup on the opaque reference but returns the bearer secret for direct room management", async () => {
    const store = new MemoryCollabCredentialStore();
    const record = { version: 2 as const, projectInstanceId: "project_12345678", host: "https://sync.example", credentialRef: "credential-reference", permission: "host" as const, title: "Paper", projectRoot: null, lastUsed: 1 };
    await store.put(record.credentialRef, "actual-bearer-secret", record.projectInstanceId, record.host);
    expect(await requireRememberedV2Credential(record, store)).toBe("credential-reference");
    expect(await readRememberedV2Credential(record, store)).toBe("actual-bearer-secret");
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

  it("closes a remotely deleted background tab without disturbing the active document", () => {
    expect(planRemoteCollabDeleteUiV2({
      path: "notes.md",
      activeFile: "paper.md",
      secondaryFile: null,
      openTabs: ["paper.md", "notes.md"],
      tabRecency: ["notes.md", "paper.md"],
      liveTextPaths: ["paper.md"],
    })).toEqual({
      openTabs: ["paper.md"],
      tabRecency: ["paper.md"],
      deletedActive: false,
      deletedSecondary: false,
      replacement: null,
    });
  });

  it("clears a deleted secondary document and selects the preferred active replacement", () => {
    const secondary = planRemoteCollabDeleteUiV2({
      path: "side.md",
      activeFile: "paper.md",
      secondaryFile: "side.md",
      openTabs: ["paper.md", "side.md"],
      tabRecency: ["side.md", "paper.md"],
      liveTextPaths: ["paper.md"],
    });
    expect(secondary.deletedSecondary).toBe(true);
    expect(secondary.deletedActive).toBe(false);

    expect(planRemoteCollabDeleteUiV2({
      path: "paper.md",
      activeFile: "paper.md",
      secondaryFile: null,
      openTabs: ["paper.md", "appendix.md"],
      tabRecency: ["paper.md", "appendix.md"],
      liveTextPaths: ["appendix.md", "index.md"],
      preferredPaths: ["index.md", "appendix.md"],
    })).toEqual({
      openTabs: ["appendix.md"],
      tabRecency: ["appendix.md"],
      deletedActive: true,
      deletedSecondary: false,
      replacement: "index.md",
    });
  });

  it("rejects a project refresh superseded by deletion or a project switch", () => {
    const scope = { expectedRoot: "/tmp/project", generation: 4 };
    expect(mayApplyProjectRefreshV2({
      refreshGeneration: 8,
      currentRefreshGeneration: 9,
      scope,
      currentProjectGeneration: 4,
      currentRoot: "/tmp/project",
      snapshotRoot: "/tmp/project",
    })).toBe(false);
    expect(mayApplyProjectRefreshV2({
      refreshGeneration: 9,
      currentRefreshGeneration: 9,
      scope,
      currentProjectGeneration: 4,
      currentRoot: "/tmp/project",
      snapshotRoot: "/tmp/project",
    })).toBe(true);
  });
});
