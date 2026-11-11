import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SYNARA_RUNTIME, type SynaraRuntimeInfo } from "../agent/synara-runtime";
import { ModelEndpointSettings } from "./model-endpoint-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const RUNNING: SynaraRuntimeInfo = { ...EMPTY_SYNARA_RUNTIME, state: "ready", origin: "http://127.0.0.1:4173", authToken: "one" };
const STOPPED: SynaraRuntimeInfo = { ...EMPTY_SYNARA_RUNTIME, state: "stopped" };

const SAVED = {
  endpoint: {
    protocol: "anthropic-messages",
    baseUrl: "https://api.example.com",
    models: [{ id: "claude-x", contextWindow: 200000, maxTokens: 8192, images: true }],
  },
  keySaved: true,
};
const EMPTY = { endpoint: null, keySaved: false };

function respond(answers: Record<string, unknown>) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? (answer as () => unknown)() : answer;
  });
}

const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

describe("ModelEndpointSettings", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());
  afterEach(cleanup);

  it("reads the saved endpoint back without ever showing the key", async () => {
    respond({ get_model_endpoint: SAVED });
    render(<ModelEndpointSettings runtime={STOPPED} openTab={vi.fn()} />);

    expect(await screen.findByDisplayValue("https://api.example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("claude-x")).toBeTruthy();
    expect(screen.getByDisplayValue("200000")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Accepts images").checked).toBe(true);
    expect(screen.getByText("Saved in the keychain. Enter a new one to replace it.")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("API key").value).toBe("");
    // Phase 1's limits are stated where the endpoint is set up.
    expect(screen.getByText(/Pi doesn’t ask before editing/)).toBeTruthy();
    expect(screen.getByText(/Proofread, Polish and revision requests still need/)).toBeTruthy();
  });

  it("saves a new endpoint with its key and restarts an idle agent", async () => {
    respond({
      get_model_endpoint: EMPTY,
      save_model_endpoint: { ...SAVED, endpoint: { ...SAVED.endpoint, protocol: "openai-completions", baseUrl: "https://api.example.com/v1", models: [{ id: "gpt-x", contextWindow: 128000, maxTokens: 16384, images: false }] } },
      restart_impact: { agentTurns: 0 },
      synara_restart: undefined,
    });
    render(<ModelEndpointSettings runtime={RUNNING} openTab={vi.fn()} />);
    const address = await screen.findByLabelText("Address");
    fireEvent.change(address, { target: { value: "https://api.example.com/v1/chat/completions" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "  sk-secret " } });
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "gpt-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/open Pi and choose a model under api.example.com/)).toBeTruthy();
    expect(calls("save_model_endpoint")[0][1]).toEqual({
      endpoint: {
        protocol: "openai-completions",
        baseUrl: "https://api.example.com/v1/chat/completions",
        models: [{ id: "gpt-x", contextWindow: 128000, maxTokens: 16384, images: false }],
      },
      key: { action: "replace", value: "sk-secret" },
    });
    expect(calls("synara_restart")).toHaveLength(1);
    // The typed key is gone from the page once saved.
    expect(screen.getByLabelText<HTMLInputElement>("API key").value).toBe("");
  });

  it("offers the restart instead of stopping a running turn", async () => {
    respond({ get_model_endpoint: SAVED, save_model_endpoint: SAVED, restart_impact: { agentTurns: 1 }, synara_restart: undefined });
    render(<ModelEndpointSettings runtime={RUNNING} openTab={vi.fn()} />);
    await screen.findByDisplayValue("claude-x");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/which would stop the turn running now/)).toBeTruthy();
    expect(calls("save_model_endpoint")[0][1]).toMatchObject({ key: { action: "keep" } });
    expect(calls("synara_restart")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Restart agent" }));
    await waitFor(() => expect(calls("synara_restart")).toHaveLength(1));
  });

  it("names what Test connection found, from the backend's codes", async () => {
    respond({
      get_model_endpoint: SAVED,
      test_model_endpoint: { passed: ["reach"], problem: "keyRejected", status: 401, detail: "invalid x-api-key" },
    });
    render(<ModelEndpointSettings runtime={STOPPED} openTab={vi.fn()} />);
    await screen.findByDisplayValue("claude-x");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText("The endpoint refused the key.")).toBeTruthy();
    expect(screen.getByText("The endpoint said: invalid x-api-key")).toBeTruthy();
    expect(screen.getAllByLabelText("Passed")).toHaveLength(1);
    // Without a typed key the saved one is used, which the page never holds.
    expect(calls("test_model_endpoint")[0][1]).toMatchObject({ key: null });
  });

  it("refuses token limits that are not whole numbers before asking the host", async () => {
    respond({ get_model_endpoint: SAVED });
    render(<ModelEndpointSettings runtime={STOPPED} openTab={vi.fn()} />);
    fireEvent.change(await screen.findByDisplayValue("200000"), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Token limits must be whole numbers.")).toBeTruthy();
    expect(calls("save_model_endpoint")).toHaveLength(0);
  });

  it("removes the endpoint and opens Providers for the Pi runtime", async () => {
    const openTab = vi.fn();
    respond({ get_model_endpoint: SAVED, remove_model_endpoint: EMPTY });
    render(<ModelEndpointSettings runtime={STOPPED} openTab={openTab} />);
    await screen.findByDisplayValue("claude-x");
    fireEvent.click(screen.getByRole("button", { name: "Open Providers" }));
    expect(openTab).toHaveBeenCalledWith("agent");

    fireEvent.click(screen.getByRole("button", { name: "Remove endpoint" }));
    expect(await screen.findByText("Endpoint removed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove endpoint" })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Address").value).toBe("");
  });
});
