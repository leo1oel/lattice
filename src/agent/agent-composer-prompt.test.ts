import { describe, expect, it } from "vitest";
import { openSlideComposerPrompt, parseAgentComposerPromptResult } from "./agent-composer-prompt";

const ROOT = "/tmp/talk";

describe("openSlideComposerPrompt", () => {
  it("sends Apply comments for the deck, and only drafts a new deck or an empty question", () => {
    expect(openSlideComposerPrompt({ kind: "apply-comments", deckPath: "slides/talk/index.tsx" }, ROOT)).toEqual({
      type: "lattice:composer-prompt", version: 1, requestId: expect.any(String), workspaceRoot: ROOT,
      text: "Apply the pending comments in slides/talk/index.tsx.", mode: "send",
    });
    expect(openSlideComposerPrompt({ kind: "draft-deck", deckPath: null }, ROOT)).toMatchObject({
      text: "Create a presentation about ", mode: "draft",
    });
    expect(openSlideComposerPrompt({ kind: "open", deckPath: "slides/talk/index.tsx" }, ROOT)).toMatchObject({ text: "", mode: "draft" });
  });

  it("gives every request its own id", () => {
    const request = { kind: "open", deckPath: null } as const;
    expect(openSlideComposerPrompt(request, ROOT).requestId).not.toBe(openSlideComposerPrompt(request, ROOT).requestId);
  });
});

describe("parseAgentComposerPromptResult", () => {
  const result = (fields: Record<string, unknown>) => ({ type: "synara:composer-prompt-result", version: 1, requestId: "r-1", ...fields });

  it("reads an outcome and an error the host acts on", () => {
    expect(parseAgentComposerPromptResult(result({ ok: true, outcome: "queued", threadId: "thread-1" })))
      .toEqual({ requestId: "r-1", ok: true, outcome: "queued", threadId: "thread-1" });
    expect(parseAgentComposerPromptResult(result({ ok: false, error: { code: "awaiting-input", message: "Answer first." } })))
      .toEqual({ requestId: "r-1", ok: false, error: { code: "awaiting-input", message: "Answer first." } });
  });

  it("drops unknown outcomes and codes, and rejects other messages", () => {
    expect(parseAgentComposerPromptResult(result({ ok: false, outcome: "exploded", error: { code: "mystery", message: "?" } })))
      .toEqual({ requestId: "r-1", ok: false });
    expect(parseAgentComposerPromptResult(result({ ok: "yes" }))).toBeNull();
    expect(parseAgentComposerPromptResult(result({ ok: true, requestId: "" }))).toBeNull();
    expect(parseAgentComposerPromptResult(result({ ok: true, version: 2 }))).toBeNull();
    expect(parseAgentComposerPromptResult({ type: "lattice:composer-prompt", version: 1, requestId: "r-1", ok: true })).toBeNull();
  });
});
