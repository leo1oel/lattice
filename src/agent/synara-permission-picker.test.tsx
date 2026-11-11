import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SynaraPermissionPicker from "./synara-permission-picker";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOTE = /With a model endpoint, Pi asks before it edits a file or runs a command in “Ask before outside edits and network”, and runs them without asking in “Never ask”/;

function open(endpoint: unknown) {
  vi.mocked(invoke).mockResolvedValue({ endpoint, keySaved: false });
  render(<SynaraPermissionPicker value="approval-required" autoModeAvailable onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Agent permissions/ }));
}

describe("SynaraPermissionPicker", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());
  afterEach(cleanup);

  it("says when Pi asks once a model endpoint is saved", async () => {
    open({ protocol: "openai-completions", baseUrl: "https://a.example/v1", models: [] });
    expect(await screen.findByText(NOTE)).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("get_model_endpoint");
  });

  it("stays quiet without one", async () => {
    open(null);
    await screen.findByRole("radio", { name: "Never ask" });
    await Promise.resolve();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
