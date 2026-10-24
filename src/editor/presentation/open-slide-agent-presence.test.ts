import { afterEach, describe, expect, it, vi } from "vitest";
import { publishAgentDeckPresence, type AgentDeckPresence } from "../../agent/agent-turn-activity";
import { forwardAgentPresence } from "./open-slide-agent-presence";

const ROOT = "/tmp/lattice-paper";
const ORIGIN = "http://127.0.0.1:4100";

const presence = (overrides: Partial<AgentDeckPresence> = {}): AgentDeckPresence => ({
  workspaceRoot: ROOT, threadId: "thread-1", turnId: "turn-1", state: "running",
  provider: { id: "claudeAgent", label: "Claude Code" }, tool: { title: "Edit", detail: null }, decks: ["talk"], ...overrides,
});

function stubFetch() {
  const pending: Array<() => void> = [];
  const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => {
    pending.push(() => resolve(new Response(null, { status: 204 })));
  }));
  vi.stubGlobal("fetch", fetch);
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).activity);
  const settle = async () => {
    while (pending.length) {
      pending.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { fetch, bodies, settle };
}

afterEach(() => {
  publishAgentDeckPresence(null);
  vi.unstubAllGlobals();
});

describe("forwardAgentPresence", () => {
  it("brings the runtime up to date, then posts each change in order, one at a time", async () => {
    const { fetch, bodies, settle } = stubFetch();
    publishAgentDeckPresence(presence());
    const stop = forwardAgentPresence(ROOT, ORIGIN, "secret");
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/__lattice/agent-activity`, expect.objectContaining({
      method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" },
    }));
    expect(bodies()).toEqual([{
      state: "running", provider: { id: "claudeAgent", label: "Claude Code" }, tool: { title: "Edit", detail: null }, decks: ["talk"],
    }]);
    // Two reports while one request is out: only the latest follows it.
    publishAgentDeckPresence(presence({ tool: null }));
    publishAgentDeckPresence(presence({ state: "waiting", tool: null }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await settle();
    expect(bodies().map((body) => body?.state ?? null)).toEqual(["running", "waiting"]);
    publishAgentDeckPresence(null);
    await settle();
    expect(bodies().at(-1)).toBeNull();
    stop();
    publishAgentDeckPresence(presence());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("serves every deck on one runtime with one stream and never shows another project's turn", async () => {
    const { fetch, bodies, settle } = stubFetch();
    publishAgentDeckPresence(presence({ workspaceRoot: "/tmp/other" }));
    const stopFirst = forwardAgentPresence(ROOT, ORIGIN, "secret");
    const stopSecond = forwardAgentPresence(ROOT, ORIGIN, "secret");
    await settle();
    expect(bodies()).toEqual([null]);
    stopFirst();
    publishAgentDeckPresence(presence());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    stopSecond();
  });
});
