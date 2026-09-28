import { describe, expect, it, vi } from "vitest";
import {
  mayApplyProjectRefreshV2,
  planRemoteCollabDeleteUiV2,
  readRememberedV2Credential,
  requireRememberedV2Credential,
} from "./collab-app-v2";
import { MemoryCollabCredentialStore } from "./collab-credentials";
import type { CollabProjectRecordV2 } from "./collab-rooms";

const record = (overrides: Partial<CollabProjectRecordV2>): CollabProjectRecordV2 => ({ version: 2, projectInstanceId: "project_12345678", host: "https://sync.example", permission: "write", title: "Paper", projectRoot: null, lastUsed: 1, ...overrides });

describe("App v2 collaboration routing", () => {
  it("reports a missing remembered credential without deleting anything", async () => {
    const store = new MemoryCollabCredentialStore(); const deleteSpy = vi.spyOn(store, "delete");
    await expect(requireRememberedV2Credential(record({ credentialRef: "missing" }), store)).rejects.toThrow("kept");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("keeps controller startup on the opaque reference but returns the bearer secret for direct room management", async () => {
    const store = new MemoryCollabCredentialStore();
    const hosted = record({ credentialRef: "credential-reference", permission: "host" });
    await store.put("credential-reference", "actual-bearer-secret", hosted.projectInstanceId, hosted.host);
    expect(await requireRememberedV2Credential(hosted, store)).toBe("credential-reference");
    expect(await readRememberedV2Credential(hosted, store)).toBe("actual-bearer-secret");
  });

  it("closes a remotely deleted background tab without disturbing the active document", () => {
    expect(planRemoteCollabDeleteUiV2({
      path: "notes.md", activeFile: "paper.md", secondaryFile: null,
      openTabs: ["paper.md", "notes.md"], tabRecency: ["notes.md", "paper.md"], liveTextPaths: ["paper.md"],
    })).toEqual({ openTabs: ["paper.md"], tabRecency: ["paper.md"], deletedActive: false, deletedSecondary: false, replacement: null });
  });

  it("clears a deleted secondary document and selects the preferred active replacement", () => {
    const secondary = planRemoteCollabDeleteUiV2({
      path: "side.md", activeFile: "paper.md", secondaryFile: "side.md",
      openTabs: ["paper.md", "side.md"], tabRecency: ["side.md", "paper.md"], liveTextPaths: ["paper.md"],
    });
    expect(secondary.deletedSecondary).toBe(true);
    expect(secondary.deletedActive).toBe(false);

    expect(planRemoteCollabDeleteUiV2({
      path: "paper.md", activeFile: "paper.md", secondaryFile: null,
      openTabs: ["paper.md", "appendix.md"], tabRecency: ["paper.md", "appendix.md"],
      liveTextPaths: ["appendix.md", "index.md"], preferredPaths: ["index.md", "appendix.md"],
    })).toEqual({ openTabs: ["appendix.md"], tabRecency: ["appendix.md"], deletedActive: true, deletedSecondary: false, replacement: "index.md" });
  });

  it("rejects a project refresh superseded by deletion or a project switch", () => {
    const current = { refreshGeneration: 9, currentRefreshGeneration: 9, scope: { expectedRoot: "/tmp/project", generation: 4 }, currentProjectGeneration: 4, currentRoot: "/tmp/project", snapshotRoot: "/tmp/project" };
    expect(mayApplyProjectRefreshV2({ ...current, refreshGeneration: 8 })).toBe(false);
    expect(mayApplyProjectRefreshV2(current)).toBe(true);
  });
});
