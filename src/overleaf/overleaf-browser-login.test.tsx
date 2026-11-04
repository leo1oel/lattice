import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverleafSettingsSection } from "./overleaf-connect";
import { invokeCalls, mockInvoke } from "../platform/tauri-test-mocks";
import type { OverleafStatus } from "../app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
const disconnected: OverleafStatus = { connected: false, expired: false, email: null, name: null, host: "https://www.overleaf.com" };
const connected: OverleafStatus = { ...disconnected, connected: true, email: "researcher@example.edu", name: "Robin" };
const cookie = "overleaf_session2=private-test-session";
function settings() {
  return render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}}
    channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("opens the default browser, then validates an explicitly imported session before connecting", async () => {
  mockInvoke({ overleaf_status: disconnected, overleaf_open_login_in_browser: undefined, overleaf_connect_session: connected });
  settings();
  fireEvent.click(await screen.findByRole("button", { name: "Open in default browser" }));
  await waitFor(() => expect(invokeCalls("overleaf_open_login_in_browser")).toHaveLength(1));
  expect(screen.queryByText(/researcher@example.edu/)).not.toBeInTheDocument();
  const input = screen.getByLabelText("Overleaf session cookie");
  expect(input).toHaveAttribute("type", "password");
  expect(input).toHaveAttribute("autocomplete", "off");
  fireEvent.change(input, { target: { value: cookie } });
  fireEvent.click(screen.getByRole("button", { name: "Import browser session" }));
  await screen.findByText(/Connected as researcher@example.edu/);
  expect(invokeCalls("overleaf_connect_session")).toEqual([{ host: disconnected.host, cookie }]);
  expect(input).toHaveValue("");
});

it("leaves a failed import editable and never renders a credential from an error", async () => {
  mockInvoke({ overleaf_status: disconnected, overleaf_open_login_in_browser: undefined,
    overleaf_connect_session: () => Promise.reject(new Error(cookie)) });
  settings();
  fireEvent.click(await screen.findByRole("button", { name: "Open in default browser" }));
  const input = await screen.findByLabelText("Overleaf session cookie");
  fireEvent.change(input, { target: { value: cookie } });
  fireEvent.click(screen.getByRole("button", { name: "Import browser session" }));
  await screen.findByText("Could not validate that session. Copy a fresh session cookie from a signed-in browser and try again.");
  expect(input).toHaveValue(cookie);
  expect(document.body.textContent).not.toContain(cookie);
  expect(screen.queryByText(/researcher@example.edu/)).not.toBeInTheDocument();
});

it("keeps manual import available if the operating system cannot open the browser", async () => {
  mockInvoke({ overleaf_status: disconnected, overleaf_open_login_in_browser: () => Promise.reject(new Error(cookie)) });
  settings();
  fireEvent.click(await screen.findByRole("button", { name: "Open in default browser" }));
  await screen.findByText("Could not open the default browser. Open Overleaf in your browser and continue with the session import below.");
  expect(screen.getByLabelText("Overleaf session cookie")).toBeEnabled();
  expect(document.body.textContent).not.toContain(cookie);
});
