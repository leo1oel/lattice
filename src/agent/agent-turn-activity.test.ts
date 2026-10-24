import { describe, expect, it } from "vitest";
import {
  contextDeck, nextAgentDeckPresence, parseAgentTurnActivity, type AgentTurnActivity,
} from "./agent-turn-activity";

const ROOT = "/tmp/lattice-paper";

function report(overrides: Record<string, unknown> = {}) {
  return {
    type: "synara:turn-activity", version: 1, workspaceRoot: ROOT, threadId: "thread-1", turnId: "turn-1",
    state: "running", provider: { id: "claude", label: "Claude Code" }, ...overrides,
  };
}

function activity(overrides: Record<string, unknown> = {}): AgentTurnActivity {
  return parseAgentTurnActivity(report(overrides))!;
}

describe("parseAgentTurnActivity", () => {
  it("reads the panel's turn and its current tool", () => {
    expect(parseAgentTurnActivity(report({
      tool: { title: "Edit", detail: "index.tsx", paths: ["slides/talk/index.tsx", "/etc/passwd", "../outside.tsx", 7] },
    }))).toEqual({
      workspaceRoot: ROOT, threadId: "thread-1", turnId: "turn-1", state: "running",
      provider: { id: "claude", label: "Claude Code" },
      tool: { title: "Edit", detail: "index.tsx", paths: ["slides/talk/index.tsx"] },
    });
    expect(parseAgentTurnActivity(report({ turnId: null, state: "waiting", tool: { title: "", paths: [] } })))
      .toEqual(expect.not.objectContaining({ tool: expect.anything() }));
  });

  it("rejects anything outside the contract", () => {
    for (const malformed of [
      null, report({ type: "synara:turn-started" }), report({ version: 2 }), report({ workspaceRoot: "" }),
      report({ threadId: " " }), report({ state: "done" }), report({ turnId: 3 }), report({ provider: "claude" }),
    ]) {
      expect(parseAgentTurnActivity(malformed)).toBeNull();
    }
  });
});

describe("nextAgentDeckPresence", () => {
  it("lights the deck the turn started on and every deck its tools enter, until the turn ends", () => {
    const started = nextAgentDeckPresence(null, activity(), "talk");
    expect(started).toEqual({
      workspaceRoot: ROOT, threadId: "thread-1", turnId: "turn-1", state: "running",
      provider: { id: "claude", label: "Claude Code" }, tool: null, decks: ["talk"],
    });
    const writing = nextAgentDeckPresence(started, activity({
      tool: { title: "Write", detail: null, paths: ["slides/launch/index.tsx", "slides/talk/assets/a.png", "notes.md"] },
    }), null);
    expect(writing).toMatchObject({ tool: { title: "Write", detail: null }, decks: ["talk", "launch"] });
    // Between tools and while waiting for an answer the turn keeps its decks.
    const waiting = nextAgentDeckPresence(writing, activity({ state: "waiting" }), "other");
    expect(waiting).toMatchObject({ state: "waiting", tool: null, decks: ["talk", "launch"] });
    expect(nextAgentDeckPresence(waiting, activity({ state: "idle" }), "talk")).toBeNull();
  });

  it("starts over for another thread or turn, and keeps a turn first reported without its id", () => {
    const first = nextAgentDeckPresence(null, activity({ turnId: null }), "talk");
    expect(nextAgentDeckPresence(first, activity({ turnId: "turn-1" }), null)).toMatchObject({ turnId: "turn-1", decks: ["talk"] });
    expect(nextAgentDeckPresence(first, activity({ threadId: "thread-2" }), null)).toMatchObject({ decks: [] });
    const named = nextAgentDeckPresence(null, activity(), "talk");
    expect(nextAgentDeckPresence(named, activity({ turnId: "turn-2" }), "launch")).toMatchObject({ decks: ["launch"] });
  });
});

describe("contextDeck", () => {
  it("names the deck in this project's context only", () => {
    const context = { workspaceRoot: ROOT, presentation: { pagePath: "slides/talk/index.tsx" } };
    expect(contextDeck(context, ROOT)).toBe("talk");
    expect(contextDeck(context, "/tmp/other")).toBeNull();
    expect(contextDeck({ workspaceRoot: ROOT }, ROOT)).toBeNull();
    expect(contextDeck(null, ROOT)).toBeNull();
  });
});
