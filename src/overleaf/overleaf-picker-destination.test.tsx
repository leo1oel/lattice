/**
 * Where "Open from Overleaf" downloads (Leo, 2026-11-18: downloads always
 * landed in Documents; "如果可以自己指定感觉会更方便"): the folder the last download
 * went to, another one chosen with Choose…, and a chosen folder that cannot
 * take a download.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverleafPickerDialog } from "./overleaf-project-picker";
import { mockInvoke } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const DOWNLOADS = { path: "/Users/me/Documents/Overleaf Projects", display: "~/Documents/Overleaf Projects" };

function mockConnectedPicker(extra: Record<string, unknown> = {}) {
  mockInvoke({
    overleaf_status: { connected: true, expired: false, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" },
    overleaf_list_projects: {
      projects: [{
        id: "p1", name: "Attention Paper", lastUpdated: "2026-07-24T00:00:00Z", ownerEmail: "researcher@example.edu",
        ownerName: "Robin", accessLevel: "owner", archived: false, trashed: false,
      }],
      invites: [],
    },
    overleaf_clone_project: "/Users/me/Papers/Attention Paper",
    overleaf_download_parent: DOWNLOADS,
    ...extra,
  });
}

function renderPicker() {
  render(<OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />);
}

async function openFirstProject() {
  fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
}

const cloneArgs = (overrides: Record<string, unknown> = {}) => ({
  projectId: "p1", name: "Attention Paper", parent: DOWNLOADS.path, accessLevel: "owner", adopt: false, ...overrides,
});

it("downloads into the folder it last used, and into another one once chosen", async () => {
  const papers = { path: "/Users/me/Papers", display: "~/Papers" };
  mockConnectedPicker({ overleaf_check_download_parent: papers, overleaf_clone_target: { kind: "fresh", path: "", folder: "" } });
  vi.mocked(openDialog).mockResolvedValue(papers.path);
  renderPicker();
  expect(await screen.findByText(DOWNLOADS.display)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
  expect(await screen.findByText(papers.display)).toBeInTheDocument();
  expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: DOWNLOADS.path }));
  expect(invoke).toHaveBeenCalledWith("overleaf_check_download_parent", { parent: papers.path });

  await openFirstProject();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs({ parent: papers.path })));
  expect(invoke).toHaveBeenCalledWith("overleaf_clone_target", { projectId: "p1", name: "Attention Paper", parent: papers.path });
});

it("says why a chosen folder cannot take a download and keeps the one it had", async () => {
  mockConnectedPicker({
    overleaf_check_download_parent: () => { throw new Error("Lattice can't save files in that folder. Choose another one."); },
  });
  vi.mocked(openDialog).mockResolvedValue("/Volumes/ReadOnly");
  renderPicker();
  await screen.findByText(DOWNLOADS.display);
  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
  expect(await screen.findByText("Lattice can't save files in that folder. Choose another one.")).toBeInTheDocument();
  expect(screen.getByText(DOWNLOADS.display)).toBeInTheDocument();

  // Cancelling the folder dialog changes nothing.
  vi.mocked(openDialog).mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
  await waitFor(() => expect(openDialog).toHaveBeenCalledTimes(2));
  expect(screen.getByText(DOWNLOADS.display)).toBeInTheDocument();
});
