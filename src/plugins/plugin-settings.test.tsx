import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmAction } from "../app-utils";
import { PluginSettings } from "./plugin-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
vi.mock("../app-utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("../app-utils")>()), confirmAction: vi.fn() }));

const disabled = { manifest: { id: "example.hello", name: "Hello", version: "1.0.0", api_version: 1, commands: [{ id: "hello", title: "Show context", executable: "hello.sh", args: [] }] }, path: "/plugins/hello", enabled: false };

describe("PluginSettings", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(open).mockReset(); vi.mocked(confirmAction).mockReset(); });
  afterEach(cleanup);

  it("does not install a selected folder without explicit trust confirmation", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    vi.mocked(open).mockResolvedValue("/plugins/hello");
    vi.mocked(confirmAction).mockResolvedValue(false);
    render(<PluginSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add plugin folder…" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith("install_plugin", expect.anything());
  });

  it("enables an installed plugin only after confirmation and runs its declared command", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_plugins") return [disabled];
      if (command === "set_plugin_enabled") return [{ ...disabled, enabled: true }];
      if (command === "run_plugin_command") return { success: true, exit_code: 0, stdout: "Hello", stderr: "" };
      return [];
    });
    vi.mocked(confirmAction).mockResolvedValue(true);
    render(<PluginSettings />);
    expect((await screen.findByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_plugin_enabled", { id: "example.hello", enabled: true }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Hello", { selector: "pre" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("run_plugin_command", { id: "example.hello", command: "hello" });
  });
});
