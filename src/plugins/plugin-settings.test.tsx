import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { PluginSettings } from "./plugin-settings";
import type { PluginInfo, PluginList } from "./plugin-ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const zotero: PluginInfo = {
  id: "dev.example.zotero-search", name: "Zotero search", version: "0.1.0", description: "Search your Zotero library and cite from it.",
  license: "MIT", repository: null, runtime: "node", source: { kind: "url", url: "https://example.org/zotero.zip", sha256: "a".repeat(64) },
  enabled: false, permissions: { projectRead: ["context", "bibliography"], networkLocal: [23119], network: ["https://api.crossref.org"], secrets: ["api-key"] },
  granted: null, needsReview: false, commands: [], secrets: [{ name: "api-key", saved: false }], error: null,
};
const quiet: PluginInfo = {
  ...zotero, id: "dev.example.quiet", name: "Quiet", source: { kind: "folder", path: "/Users/me/plugins/quiet" },
  permissions: { projectRead: [], networkLocal: [], network: [], secrets: [] }, secrets: [],
};
let list: PluginList;

beforeEach(() => {
  list = { available: true, plugins: [zotero] };
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => (command === "plugins_list" ? list : zotero));
});
afterEach(cleanup);

const card = async (name: string) => (await screen.findByText(name, { selector: ".ui-settings-group-title" })).closest("section") as HTMLElement;

it("shows each plugin's card with what it may access, in plain words", async () => {
  list = { available: true, plugins: [zotero, quiet] };
  render(<PluginSettings />);
  const first = within(await card("Zotero search"));
  expect(first.getByText("dev.example.zotero-search")).toBeInTheDocument();
  expect(first.getByText("Licence: MIT")).toBeInTheDocument();
  expect(first.getByText("From https://example.org/zotero.zip")).toBeInTheDocument();
  expect(first.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Read the open file, selection and cursor", "Read the project’s bibliography", "Connect to localhost:23119",
    "Send requests to https://api.crossref.org", "Use the saved secret “api-key”",
  ]);
  const second = within(await card("Quiet"));
  expect(second.getByText("Folder /Users/me/plugins/quiet")).toBeInTheDocument();
  expect(second.getByRole("listitem")).toHaveTextContent("No access beyond the project’s name");
});

it("asks before turning a plugin on, listing its permissions, and grants only on Turn on", async () => {
  render(<PluginSettings />);
  fireEvent.click(await screen.findByRole("switch", { name: "Turn on Zotero search" }));
  const dialog = await screen.findByRole("dialog", { name: "Turn on Zotero search?" });
  expect(within(dialog).getByText("Connect to localhost:23119")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(invoke).not.toHaveBeenCalledWith("plugins_set_enabled", expect.anything());
  fireEvent.click(screen.getByRole("switch", { name: "Turn on Zotero search" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_set_enabled", { id: zotero.id, enabled: true }));
});

// Turning a plugin on happens inside Settings, itself a dialog: the question
// must stack above it, its backdrop covering the Settings card, or a press
// meant for it lands on Settings (Leo, plugin hand test, 2026-11-18).
it("stacks the permission question above Settings, on the confirmations' layer", async () => {
  render(<PluginSettings />);
  fireEvent.click(await screen.findByRole("switch", { name: "Turn on Zotero search" }));
  const dialog = await screen.findByRole("dialog", { name: "Turn on Zotero search?" });
  const backdrop = dialog.previousElementSibling;
  expect(backdrop).toHaveClass("modal-backdrop", "confirm-action-backdrop");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("turns a plugin off without asking", async () => {
  list = { available: true, plugins: [{ ...zotero, enabled: true, granted: zotero.permissions }] };
  render(<PluginSettings />);
  fireEvent.click(await screen.findByRole("switch", { name: "Turn off Zotero search" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_set_enabled", { id: zotero.id, enabled: false }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("warns when an update asks for more, and Review asks again", async () => {
  list = { available: true, plugins: [{ ...zotero, enabled: true, needsReview: true }] };
  render(<PluginSettings />);
  expect(await screen.findByText("Asks for new permissions")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review…" }));
  expect(await screen.findByRole("dialog", { name: "Turn on Zotero search?" })).toBeInTheDocument();
});

it("off macOS, says plugins don't run and keeps the switches off", async () => {
  list = { available: false, plugins: [zotero] };
  render(<PluginSettings />);
  expect(await screen.findByText("Plugins run only on macOS for now. They are listed here, but can’t be turned on.")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Turn on Zotero search" })).toBeDisabled();
});

it("installs from a URL with its SHA-256, and shows the host's refusal under the form", async () => {
  list = { available: true, plugins: [] };
  render(<PluginSettings />);
  expect(await screen.findByText("No plugins installed.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Install from URL…" }));
  const install = screen.getByRole("button", { name: "Install" });
  fireEvent.change(screen.getByLabelText("Plugin URL"), { target: { value: " https://example.org/p.zip " } });
  fireEvent.change(screen.getByLabelText("SHA-256 checksum"), { target: { value: "abc" } });
  expect(install).toBeDisabled();
  fireEvent.change(screen.getByLabelText("SHA-256 checksum"), { target: { value: "b".repeat(64) } });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "plugins_install_url") throw "The plugin's licence (Proprietary) is not one Lattice accepts for installed plugins.";
    return list;
  });
  fireEvent.click(install);
  expect(await screen.findByText("The plugin's licence (Proprietary) is not one Lattice accepts for installed plugins.")).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("plugins_install_url", { url: "https://example.org/p.zip", sha256: "b".repeat(64) });
});

it("installs from a chosen folder", async () => {
  vi.mocked(open).mockResolvedValue("/Users/me/plugins/hello");
  render(<PluginSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose folder…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_install_folder", { path: "/Users/me/plugins/hello" }));
});

it("saves and clears a secret without showing it again", async () => {
  render(<PluginSettings />);
  const field = await screen.findByLabelText("api-key");
  expect(field).toHaveAttribute("type", "password");
  expect(screen.getByText("Not saved")).toBeInTheDocument();
  fireEvent.change(field, { target: { value: " secret " } });
  list = { available: true, plugins: [{ ...zotero, secrets: [{ name: "api-key", saved: true }] }] };
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
  expect(invoke).toHaveBeenCalledWith("plugins_set_secret", { id: zotero.id, name: "api-key", value: "secret" });
  expect(await screen.findByText("Saved")).toBeInTheDocument();
  expect(field).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_set_secret", { id: zotero.id, name: "api-key", value: null }));
});

it("shows a plugin's own error on its card", async () => {
  list = { available: true, plugins: [{ ...zotero, error: "A node plugin needs `main`." }] };
  render(<PluginSettings />);
  expect(await screen.findByText("A node plugin needs `main`.")).toBeInTheDocument();
});
