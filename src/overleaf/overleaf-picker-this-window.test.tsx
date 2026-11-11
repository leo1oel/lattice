import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverleafPickerDialog } from "./overleaf-project-picker";
import { mockInvoke } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(cleanup);

/**
 * "Open in this window" (#822): with a project open here, Open still gives
 * the chosen project a window of its own, and this choice beside it puts it
 * in this window instead, whether it downloads or opens a local copy.
 */
const LOCAL_COPY = { path: "/Users/me/Papers/Attention", display: "~/Papers/Attention" };

function mockConnected(extra: Record<string, unknown> = {}) {
  mockInvoke({
    overleaf_status: { connected: true, expired: false, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" },
    overleaf_list_projects: {
      projects: [{
        id: "p1", name: "Attention Paper", lastUpdated: "2026-07-24T00:00:00Z", ownerEmail: "researcher@example.edu",
        ownerName: "Robin", accessLevel: "owner", archived: false, trashed: false,
      }],
      invites: [],
    },
    overleaf_clone_project: "/tmp/cloned/Attention Paper",
    ...extra,
  });
}

function renderPicker(props: Partial<Parameters<typeof OverleafPickerDialog>[0]> = {}) {
  const callbacks = { onClose: vi.fn(), onCloned: vi.fn() };
  render(<OverleafPickerDialog open {...callbacks} {...props} />);
  return callbacks;
}

it("opens the local copy in this window when asked", async () => {
  mockConnected({ overleaf_local_copies: { p1: LOCAL_COPY }, overleaf_reopen_local_copy: undefined });
  const onOpenLocalCopy = vi.fn();
  renderPicker({ onOpenLocalCopy, canOpenHere: true });
  fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open in this window" }));
  await waitFor(() => expect(onOpenLocalCopy).toHaveBeenCalledWith(LOCAL_COPY.path, true));
});

it("hands a download for this window back with that choice", async () => {
  mockConnected();
  const { onCloned } = renderPicker({ canOpenHere: true });
  fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open in this window" }));
  await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper", true));
});

it("offers only Open in an empty window, which takes the project itself", async () => {
  mockConnected();
  renderPicker();
  fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
  expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open in this window" })).toBeNull();
});
