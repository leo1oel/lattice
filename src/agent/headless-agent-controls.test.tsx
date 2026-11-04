import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { HeadlessAgentControls } from "./headless-agent-controls";
import { registerHeadlessAgentProxy } from "./headless-agent-url";
import { normalizeSynaraOrigin, synaraFrameUrl } from "./synara-runtime";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.mocked(invoke).mockReset());

it("applies the active project's staged edits and presents concurrent conflicts for review", async () => {
  vi.mocked(invoke).mockResolvedValue({ applied: ["notes.md"], blocked: [{ path: "main.tex", reason: "original_changed" }] });
  render(<HeadlessAgentControls projectRoot="/projects/paper" />);
  fireEvent.click(screen.getByRole("button", { name: "Apply checked changes" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("headless_agent_apply", { projectRoot: "/projects/paper" }));
  expect(await screen.findByText("Applied: 1; needs review: 1")).toBeInTheDocument();
  expect(screen.getByText("main.tex")).toBeInTheDocument();
});
it("shows a refused writeback without claiming that edits were applied", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("The agent project changed."));
  render(<HeadlessAgentControls projectRoot="/projects/paper" />);
  fireEvent.click(screen.getByRole("button", { name: "Apply checked changes" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The agent project changed."));
});
it("keeps message origins canonical while the frame uses its authenticated proxy prefix", () => {
  const origin = window.location.origin;
  registerHeadlessAgentProxy(`${origin}/api/agent/client-1234567890/`);
  const normalized = normalizeSynaraOrigin(`${origin}/api/agent/client-1234567890/`)!;
  expect(normalized).toBe(origin);
  const url = new URL(synaraFrameUrl({ origin: normalized, path: "/source-control", workspaceRoot: "/projects/paper", theme: "dark", hostOrigin: origin }));
  expect(url.pathname).toBe("/api/agent/client-1234567890/source-control");
  expect(url.hash).toBe("");
  expect(url.searchParams.has("token")).toBe(false);
  expect(url.searchParams.get("workspaceRoot")).toBe("/projects/paper");
});
