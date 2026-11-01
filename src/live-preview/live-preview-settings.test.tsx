import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LivePreviewSettings } from "./live-preview-settings";
import type { LivePreview, LivePreviewInstall, LivePreviewState } from "./use-live-preview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const READY: LivePreviewInstall = { supported: true, lualatex: true, installed: false, version: "0.0.6" };
beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(READY); });

function settings(state: LivePreviewState, overrides: Partial<LivePreview> = {}) {
  const livePreview = {
    available: true, enabled: true, state, setEnabled: vi.fn(), retry: vi.fn(), remove: vi.fn(), buildHooks: { current: null },
    ...overrides,
  } as LivePreview;
  render(<LivePreviewSettings livePreview={livePreview} />);
  return livePreview;
}

it.each([
  [{ supported: false, lualatex: false }, "Live preview needs a Mac with Apple silicon"],
  [{ supported: true, lualatex: false }, /Live preview needs LuaLaTeX, and Lattice could not run it/],
])("says why a Mac that cannot run it shows the switch off and disabled", async (host, reason) => {
  vi.mocked(invoke).mockResolvedValue({ ...READY, ...host });
  settings({ kind: "unavailable" });
  expect(await screen.findByText(reason)).toBeInTheDocument();
  const toggle = screen.getByRole("switch", { name: "Live preview" });
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
});

it("offers a retry after a failed download", async () => {
  const livePreview = settings({ kind: "download-failed", message: "Could not download the rtex live preview engine: offline" });
  expect(await screen.findByText("Could not download the rtex live preview engine: offline")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Live preview" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(livePreview.retry).toHaveBeenCalled();
});

it("lets the writer turn the default off", async () => {
  const livePreview = settings({ kind: "off" });
  const toggle = await screen.findByRole("switch", { name: "Live preview" });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(livePreview.setEnabled).toHaveBeenCalledWith(false);
});
