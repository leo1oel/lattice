import { describe, expect, it } from "vitest";
import {
  agentGitWorkspacePath,
  LATTICE_PROJECT_HISTORY,
  normalizeSynaraOrigin,
  parseAgentProjectHistorySnapshot,
  synaraFrameUrl,
} from "./synara-runtime";

describe("Synara runtime URLs", () => {
  it("maps the native Git workspace tabs to embedded routes", () => {
    expect(agentGitWorkspacePath("changes")).toBe("/source-control");
    expect(agentGitWorkspacePath("pull-requests")).toBe("/pull-requests/");
  });

  it("normalizes an origin without retaining paths or credentials", () => {
    expect(normalizeSynaraOrigin("http://127.0.0.1:4567/chat?token=nope")).toBe(
      "http://127.0.0.1:4567",
    );
    expect(normalizeSynaraOrigin("file:///tmp/synara")).toBeNull();
  });

  it("keeps the runtime credential in the fragment", () => {
    const url = new URL(
      synaraFrameUrl({
        origin: "http://127.0.0.1:4567",
        workspaceRoot: "/Users/me/Research paper",
        theme: "dark",
        hostOrigin: "http://localhost:1420",
        authToken: "secret token",
      }),
    );
    expect(url.searchParams.get("workspaceRoot")).toBe("/Users/me/Research paper");
    expect(url.searchParams.get("embed")).toBe("1");
    expect(url.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(url.hash.slice(1)).get("lattice-auth")).toBe("secret token");
  });

  it("accepts only complete Agent checkpoint history snapshots", () => {
    const snapshot = {
      type: LATTICE_PROJECT_HISTORY,
      activeThreadId: "thread-1",
      entries: [{
        id: "agent:thread-1:turn-1",
        label: "Agent revised the introduction",
        timestamp: "2026-07-29T12:00:00Z",
        threadId: "thread-1",
        threadTitle: "Revise introduction",
        turnId: "turn-1",
        turnCount: 1,
        checkpointRef: "refs/lattice/checkpoints/one",
        files: [{ path: "main.tex", kind: "modified", additions: 4, deletions: 2 }],
      }],
    };

    expect(parseAgentProjectHistorySnapshot(snapshot)).toEqual(snapshot);
    expect(parseAgentProjectHistorySnapshot({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], turnCount: -1 }],
    })).toBeNull();
  });
});
