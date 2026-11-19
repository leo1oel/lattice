import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGuardSettings } from "./agent-guard-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const report = (overrides: Record<string, unknown> = {}) => ({
  applies: true,
  needsReducedIsolation: false,
  reducedIsolation: false,
  forwardSshAgent: false,
  ...overrides,
});

/** Answer the read with `loaded`, and each save with what it asked for, or with `saveError`. */
function respond(loaded: unknown, saveError?: string) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    if (command === "synara_guard_options") return loaded;
    if (saveError) throw saveError;
    return { ...(loaded as object), ...(args as { options: object }).options };
  });
}

const saves = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "synara_set_guard_options").map(([, args]) => (args as { options: unknown }).options);

describe("AgentGuardSettings", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });
  afterEach(cleanup);

  it("shows nothing where the agent's guard has no options, or the host has none to give", async () => {
    respond(report({ applies: false }));
    const { container, unmount } = render(<AgentGuardSettings />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synara_guard_options"));
    expect(container).toBeEmptyDOMElement();
    unmount();
    respond(undefined);
    expect(render(<AgentGuardSettings />).container).toBeEmptyDOMElement();
  });

  it("offers the SSH agent, off, and saves it with the other option as it was", async () => {
    respond(report());
    render(<AgentGuardSettings />);
    const ssh = await screen.findByRole("switch", { name: "Let the agent use your SSH agent" });
    expect(ssh).not.toBeChecked();
    // A kernel that scopes the sandbox has nothing to give up.
    expect(screen.queryByRole("switch", { name: "Run the agent with reduced isolation" })).toBeNull();
    expect(document.querySelector('[data-setting="agent-forward-ssh-agent"]')).toHaveTextContent("git over SSH and signed commits do not work inside the agent");
    fireEvent.click(ssh);
    await waitFor(() => expect(ssh).toBeChecked());
    expect(saves()).toEqual([{ reducedIsolation: false, forwardSshAgent: true }]);
    expect(screen.getByText("Changes here apply the next time the agent starts.")).toBeInTheDocument();
  });

  it("offers reduced isolation, off, where the kernel cannot scope the sandbox, and says what it gives up", async () => {
    respond(report({ needsReducedIsolation: true }));
    render(<AgentGuardSettings />);
    const reduced = await screen.findByRole("switch", { name: "Run the agent with reduced isolation" });
    expect(reduced).not.toBeChecked();
    const row = document.querySelector('[data-setting="agent-reduced-isolation"]');
    expect(row).toHaveTextContent("Linux 6.12 or later");
    expect(row).toHaveTextContent("can reach them, so it could escape its sandbox");
    fireEvent.click(reduced);
    await waitFor(() => expect(reduced).toBeChecked());
    expect(saves()).toEqual([{ reducedIsolation: true, forwardSshAgent: false }]);
  });

  it("keeps the reduced isolation switch where it was left on, so it can be turned off", async () => {
    respond(report({ reducedIsolation: true }));
    render(<AgentGuardSettings />);
    const reduced = await screen.findByRole("switch", { name: "Run the agent with reduced isolation" });
    expect(reduced).toBeChecked();
    // This kernel has the scope: the row must not say it has none.
    const row = document.querySelector('[data-setting="agent-reduced-isolation"]');
    expect(row).toHaveTextContent("this changes nothing here");
    expect(row).not.toHaveTextContent("cannot keep the agent away");
    fireEvent.click(reduced);
    await waitFor(() => expect(saves()).toEqual([{ reducedIsolation: false, forwardSshAgent: false }]));
  });

  it("puts a switch back and says why when the save fails", async () => {
    respond(report(), "Could not save the agent settings: disk full");
    render(<AgentGuardSettings />);
    const ssh = await screen.findByRole("switch", { name: "Let the agent use your SSH agent" });
    fireEvent.click(ssh);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save the agent settings: disk full"));
    expect(ssh).not.toBeChecked();
  });
});
