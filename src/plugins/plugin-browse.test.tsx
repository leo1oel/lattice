import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PluginSettings } from "./plugin-settings";
import type { PluginInfo, PluginList, PluginPermissions } from "./plugin-ipc";
import type { IndexPlugin, PluginListing } from "./plugin-registry";
import { matchesPluginQuery, sortPlugins } from "./plugin-registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const none: PluginPermissions = { projectRead: [], networkLocal: [], network: [], secrets: [] };
const crossref: IndexPlugin = {
  id: "dev.example.crossref", name: "Crossref lookup", version: "0.2.0", api: 1, runtime: "node", license: "MIT",
  author: "Ada", description: "Finds a DOI for the selected reference.", repository: "https://github.com/example/crossref",
  categories: ["citations"], permissions: { ...none, projectRead: ["context"], network: ["https://api.crossref.org"] },
  commands: [{ id: "lookup", title: "Look up DOI", description: "For the selected text" }], size: 1000, downloads: 1200, updated: "2026-11-01T00:00:00Z",
};
const wordCount: IndexPlugin = {
  ...crossref, id: "dev.example.words", name: "Word count", description: "Counts words per section.", author: "Grace",
  permissions: { ...none, projectRead: ["context"] }, commands: [], downloads: 40, updated: "2026-11-10T00:00:00Z",
};
const installed = (plugin: IndexPlugin, overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description, license: plugin.license, repository: plugin.repository,
  runtime: "node", source: { kind: "registry", url: "https://example.org/p.zip", sha256: "a".repeat(64) }, enabled: false,
  permissions: plugin.permissions, granted: null, needsReview: false, commands: [], secrets: [], error: null, ...overrides,
});

let list: PluginList;
let listing: PluginListing;
beforeEach(() => {
  list = { available: true, plugins: [] };
  listing = { plugins: [crossref, wordCount], verified: true, blockedOffers: {}, fetchedAt: "2026-11-18T00:00:00Z", status: { kind: "fresh" }, installed: [] };
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
    if (command === "plugins_list") return list;
    if (command === "plugins_registry") return listing;
    return installed(crossref);
  });
});
afterEach(cleanup);

const browse = async () => {
  render(<PluginSettings />);
  fireEvent.click(await screen.findByRole("tab", { name: "Browse" }));
};
const row = async (name: string) => (await screen.findByText(name, { selector: ".plugin-browse-name" })).closest("li") as HTMLElement;

it("searches the plugin list and shows a plugin's access before it installs", async () => {
  await browse();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_registry", { refresh: true }));
  expect(within(await row("Crossref lookup")).getByText("Ada, 1.2K downloads")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search plugins" }), { target: { value: "words" } });
  await waitFor(() => expect(screen.queryByText("Crossref lookup")).toBeNull());
  expect(await row("Word count")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search plugins" }), { target: { value: "" } });
  fireEvent.click(within(await row("Crossref lookup")).getByRole("button", { name: "Install…" }));
  const sheet = await screen.findByRole("dialog", { name: "Crossref lookup" });
  expect(within(sheet).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Read the open file, selection and cursor", "Send requests to https://api.crossref.org", "Look up DOIFor the selected text",
  ]);
  expect(invoke).not.toHaveBeenCalledWith("plugins_install_registry", expect.anything());
});

it("installs and turns on, or installs only, from the details sheet", async () => {
  await browse();
  fireEvent.click(within(await row("Crossref lookup")).getByRole("button", { name: "Install…" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install and turn on" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_set_enabled", { id: crossref.id, enabled: true }));
  expect(invoke).toHaveBeenCalledWith("plugins_install_registry", { id: crossref.id });

  vi.mocked(invoke).mockClear();
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install only" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_install_registry", { id: crossref.id }));
  expect(invoke).not.toHaveBeenCalledWith("plugins_set_enabled", expect.anything());
});

it("lists only what an update adds, and keeps the installed version on Keep", async () => {
  list = { available: true, plugins: [installed(crossref, { version: "0.1.0", enabled: true, permissions: { ...none, projectRead: ["context"] } })] };
  listing.installed = [{ id: crossref.id, version: "0.1.0", update: "0.2.0", updateAsks: { ...none, network: ["https://api.crossref.org"] }, blocked: null }];
  render(<PluginSettings />);
  expect(await screen.findByText("Version 0.2.0 is available")).toBeInTheDocument();
  expect(screen.getByText("Reviewed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Update…" }));
  const sheet = await screen.findByRole("dialog", { name: "Crossref lookup" });
  const asks = within(sheet).getByText("Version 0.2.0 also wants:").closest("section") as HTMLElement;
  expect(within(asks).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Send requests to https://api.crossref.org"]);
  fireEvent.click(within(sheet).getByRole("button", { name: "Keep 0.1.0" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(invoke).not.toHaveBeenCalledWith("plugins_install_registry", expect.anything());
});

it("updates all at once only the plugins whose update asks for nothing new", async () => {
  list = { available: true, plugins: [installed(crossref, { version: "0.1.0" }), installed(wordCount, { version: "0.1.0" })] };
  listing.installed = [
    { id: crossref.id, version: "0.1.0", update: "0.2.0", updateAsks: { ...none, network: ["https://api.crossref.org"] }, blocked: null },
    { id: wordCount.id, version: "0.1.0", update: "0.2.0", updateAsks: none, blocked: null },
  ];
  render(<PluginSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugins_install_registry", { id: wordCount.id }));
  expect(invoke).not.toHaveBeenCalledWith("plugins_install_registry", { id: crossref.id });
});

it("shows why Lattice turned a plugin off and keeps its switch off", async () => {
  const entry = { id: crossref.id, versions: "*", action: "disable", reason: "Sends the bibliography to an undeclared server.", url: null };
  list = { available: true, plugins: [installed(crossref, { blocked: entry })] };
  render(<PluginSettings />);
  expect(await screen.findByText("Lattice turned this plugin off: Sends the bibliography to an undeclared server.")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Turn on Crossref lookup" })).toBeDisabled();
});

it("can't install off macOS or from a list it couldn't verify", async () => {
  list = { available: false, plugins: [] };
  await browse();
  fireEvent.click(within(await row("Crossref lookup")).getByRole("button", { name: "Install…" }));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Plugins run only on macOS for now.")).toBeInTheDocument();
  expect(within(sheet).getByRole("button", { name: "Install and turn on" })).toBeDisabled();
  cleanup();

  list = { available: true, plugins: [] };
  listing = { ...listing, status: { kind: "refused", message: "bad signature" } };
  await browse();
  expect(await screen.findByText("Couldn't verify the plugin list. Nothing new can be installed.")).toBeInTheDocument();
  fireEvent.click(within(await row("Crossref lookup")).getByRole("button", { name: "Install…" }));
  expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install only" })).toBeDisabled();
});

it("matches across words and scripts, and sorts by downloads or date", () => {
  expect(matchesPluginQuery({ ...crossref, description: "查找参考文献的 DOI" }, "参考")).toBe(true);
  expect(matchesPluginQuery(crossref, "ada doi")).toBe(true);
  expect(matchesPluginQuery(crossref, "zotero")).toBe(false);
  expect(sortPlugins([wordCount, crossref], "popular").map((plugin) => plugin.id)).toEqual([crossref.id, wordCount.id]);
  expect(sortPlugins([crossref, wordCount], "recent").map((plugin) => plugin.id)).toEqual([wordCount.id, crossref.id]);
});
