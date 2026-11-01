import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SYNARA_RUNTIME, type SynaraRuntimeInfo } from "../agent/synara-runtime";
import { AgentEnvironmentSettings } from "./agent-environment-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const RUNNING: SynaraRuntimeInfo = { ...EMPTY_SYNARA_RUNTIME, state: "ready", origin: "http://127.0.0.1:4173", authToken: "one" };

const report = (overrides: Record<string, unknown> = {}) => ({
  running: true,
  stale: false,
  shell: "zsh",
  shellError: null,
  variables: [
    { name: "ANTHROPIC_AUTH_TOKEN", value: "••••cdef", source: "shell" },
    { name: "ANTHROPIC_BASE_URL", value: "https://api.moonshot.cn/anthropic", source: "shell" },
    { name: "HTTPS_PROXY", value: "http://127.0.0.1:7890", source: "systemProxy" },
  ],
  ...overrides,
});

function respond(answers: Record<string, unknown>) {
  vi.mocked(invoke).mockImplementation(async (command: string) => answers[command]);
}

describe("AgentEnvironmentSettings", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });
  afterEach(cleanup);

  it("lists what the agent receives, as the backend redacted it, with where each came from", async () => {
    respond({ synara_agent_environment: report() });
    render(<AgentEnvironmentSettings runtime={RUNNING} />);

    const token = await screen.findByText("ANTHROPIC_AUTH_TOKEN");
    const row = token.closest<HTMLElement>("[data-slot='settings-row']")!;
    expect(within(row).getByText("••••cdef")).toBeTruthy();
    expect(within(row).getByText("From your login shell")).toBeTruthy();
    const proxy = screen.getByText("HTTPS_PROXY").closest<HTMLElement>("[data-slot='settings-row']")!;
    expect(within(proxy).getByText("From the macOS proxy settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart agent" })).toBeTruthy();
  });

  it("restarts a stale agent and reads the environment again", async () => {
    respond({ synara_agent_environment: report({ stale: true }), synara_restart: undefined });
    render(<AgentEnvironmentSettings runtime={RUNNING} />);

    expect(await screen.findByText(/started with different values/)).toBeTruthy();
    respond({ synara_agent_environment: report(), synara_restart: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Restart agent" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synara_restart"));
    await waitFor(() => expect(screen.queryByText(/started with different values/)).toBeNull());
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "synara_agent_environment")).toHaveLength(2);
  });

  it("explains a login shell that never answered and offers no restart before the agent runs", async () => {
    respond({ synara_agent_environment: report({ running: false, shellError: "timeout", variables: [] }) });
    render(<AgentEnvironmentSettings runtime={EMPTY_SYNARA_RUNTIME} />);

    expect(await screen.findByText(/zsh did not finish starting within 5 seconds/)).toBeTruthy();
    expect(screen.getByText("None found")).toBeTruthy();
    expect(screen.getByText("The agent reads these each time it starts.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull();
  });
});
