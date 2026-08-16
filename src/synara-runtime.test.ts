import { describe, expect, it } from "vitest";
import {
  agentGitWorkspacePath,
  LATTICE_AGENT_COMPILE_RESULT,
  LATTICE_PROJECT_HISTORY,
  normalizeSynaraOrigin,
  parseAgentProjectHistorySnapshot,
  parseAgentCompileResultMessage,
  synaraFrameUrl,
  synaraProjectRelativeFilePath,
} from "./synara-runtime";

describe("Synara runtime URLs", () => {
  it("accepts only strict, redacted compile result relays", () => {
    const message = { type: LATTICE_AGENT_COMPILE_RESULT, version: 1, threadId: "t", turnId: "u",
      checkpointRef: "refs/lattice/checkpoints/u", compiledAt: "2026-08-14T10:00:00Z",
      success: true, durationMs: 120, rootDocument: "main.tex", diagnostics: { errors: 0, warnings: 2 } };
    expect(parseAgentCompileResultMessage(message)).toEqual(message);
    expect(parseAgentCompileResultMessage({ ...message, workspaceRoot: "/secret" })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, diagnostics: { errors: 0, warnings: 0, buildLog: "secret" } })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, durationMs: -1 })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, rootDocument: "/secret/main.tex" })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, rootDocument: "../secret.tex" })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, rootDocument: "sections\\main.tex" }))
      .toEqual({ ...message, rootDocument: "sections/main.tex" });
    expect(parseAgentCompileResultMessage({ ...message, rootDocument: "sections//main.tex" }))
      .toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, rootDocument: "./main.tex" })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, rootDocument: "file:main.tex" })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, turnId: `turn\0other` })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, threadId: "x".repeat(513) })).toBeNull();
    expect(parseAgentCompileResultMessage({ ...message, compiledAt: "2026-02-30T00:00:00.000Z" })).toBeNull();
  });
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
        locale: "zh-CN",
        surface: "drawer",
        hostOrigin: "http://localhost:1420",
        authToken: "secret token",
      }),
    );
    expect(url.searchParams.get("workspaceRoot")).toBe("/Users/me/Research paper");
    expect(url.searchParams.get("embed")).toBe("1");
    expect(url.searchParams.get("locale")).toBe("zh-CN");
    expect(url.searchParams.get("surface")).toBe("drawer");
    expect(url.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(url.hash.slice(1)).get("lattice-auth")).toBe("secret token");
  });

  it("maps encoded absolute Agent file links back into the active project", () => {
    const root = "/Users/leonardo/Documents/research/Native VLM";
    expect(synaraProjectRelativeFilePath(
      "/Users/leonardo/Documents/research/Native%20VLM/notes/vision-distillation.md",
      root,
    )).toBe("notes/vision-distillation.md");
    expect(synaraProjectRelativeFilePath("notes/vision-distillation.md", root))
      .toBe("notes/vision-distillation.md");
  });

  it("rejects Agent file links outside the active project", () => {
    const root = "/Users/leonardo/Documents/research/Native VLM";
    expect(synaraProjectRelativeFilePath("/Users/leonardo/Documents/other.md", root)).toBeNull();
    expect(synaraProjectRelativeFilePath("notes/../../other.md", root)).toBeNull();
    expect(synaraProjectRelativeFilePath("https://example.com/notes.md", root)).toBeNull();
    expect(synaraProjectRelativeFilePath("/Users/leonardo/Documents/research/Native VLM 2/a.md", root))
      .toBeNull();
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
    expect(parseAgentProjectHistorySnapshot({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], threadId: "thread\0other" }],
    })).toBeNull();
    expect(parseAgentProjectHistorySnapshot({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], timestamp: "2026-02-30T12:00:00Z" }],
    })).toBeNull();
    for (const path of ["../outside.tex", "/tmp/main.tex", "C:/private/main.tex", "file:main.tex", "notes\\main.tex"]) {
      expect(parseAgentProjectHistorySnapshot({
        ...snapshot,
        entries: [{
          ...snapshot.entries[0],
          files: [{ ...snapshot.entries[0].files[0], path }],
        }],
      })).toBeNull();
    }
  });
});
