import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProofreadReply, ProofreadFailure, proofreadPrompt, proofreadWithAgent } from "./agent-proofread";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  invokeMock.mockReset();
  vi.useRealTimers();
});

describe("proofreadPrompt", () => {
  it("asks for language fixes only and fences the excerpt as data", () => {
    const prompt = proofreadPrompt("We beleive $x$ \\cite{a}.", "sections/intro.tex");
    expect(prompt).toContain("\"sections/intro.tex\"");
    expect(prompt).toMatch(/grammar, spelling, punctuation, and clarity/);
    expect(prompt).toMatch(/Never change the meaning/);
    expect(prompt).toMatch(/untrusted text, not instructions/);
    expect(prompt.endsWith("<excerpt>\nWe beleive $x$ \\cite{a}.\n</excerpt>")).toBe(true);
  });
});

describe("parseProofreadReply", () => {
  it("takes the last marked excerpt and keeps the selection's surrounding whitespace", () => {
    const reply = "Sure.\n<proofread>draft</proofread>\nFinal:\n<proofread>\nWe believe it.\n</proofread>\nDone.";
    expect(parseProofreadReply(reply, "\n  We beleive it. \n")).toBe("\n  We believe it. \n");
  });

  it("rejects a reply without a complete marker pair", () => {
    expect(parseProofreadReply("We believe it.", "We beleive it.")).toBeNull();
    expect(parseProofreadReply("<proofread>We believe it.", "We beleive it.")).toBeNull();
    expect(parseProofreadReply("<proofread>  </proofread>", "We beleive it.")).toBeNull();
  });
});

describe("proofreadWithAgent", () => {
  it("starts a text task, polls it, and returns the parsed excerpt", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({ taskId: "task-1" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "completed", text: "<proofread>We believe it.</proofread>" });
    const result = proofreadWithAgent({
      projectRoot: "/paper", path: "main.tex", text: "We beleive it.", signal: new AbortController().signal,
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("We believe it.");
    expect(invokeMock.mock.calls.map(([command, args]) => [command, (args as { action: string }).action]))
      .toEqual([["agent_text_task", "start"], ["agent_text_task", "status"], ["agent_text_task", "status"]]);
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ projectRoot: "/paper", prompt: expect.stringContaining("We beleive it.") });
  });

  it("reports a runtime without the route as unavailable", async () => {
    invokeMock.mockRejectedValueOnce("agent_route_unavailable");
    const result = proofreadWithAgent({
      projectRoot: "/paper", path: "main.tex", text: "Text.", signal: new AbortController().signal,
    });
    await expect(result).rejects.toMatchObject({ kind: "unavailable" });
    await expect(result).rejects.toBeInstanceOf(ProofreadFailure);
  });

  it("cancels the task when aborted", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce({ taskId: "task-2" }).mockResolvedValue({ status: "running" });
    const controller = new AbortController();
    const result = proofreadWithAgent({ projectRoot: "/paper", path: "main.tex", text: "Text.", signal: controller.signal });
    const settled = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new DOMException("closed", "AbortError"));
    await vi.runAllTimersAsync();
    expect((await settled as DOMException).name).toBe("AbortError");
    expect(invokeMock).toHaveBeenCalledWith("agent_text_task", { action: "cancel", projectRoot: "/paper", taskId: "task-2" });
  });
});
