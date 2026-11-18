import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BrowseThemesSheet, ThemeBlockNotice } from "./theme-browse";
import type { IndexTheme, RegistryListing } from "./theme-registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const entry = (id: string, name: string, description: string): IndexTheme => ({
  id, name, version: "1.0.0", author: "Example", license: "MIT", description,
  repository: "https://github.com/example/themes",
  variants: [{ id: "night", name: null, appearance: "dark", colors: { chrome: "#101018", accent: "#9ccfd8" } }],
});
const harbor = entry("dev.example.harbor", "Harbor", "Calm blues for long nights.");
const ink = entry("dev.example.ink", "Ink", "墨色的深夜主题");

const listing = (patch: Partial<RegistryListing> = {}): RegistryListing => ({
  index: { serial: 3, generated: "2026-11-18T12:00:00Z", themes: [harbor, ink] },
  blockedOffers: {},
  fetchedAt: new Date().toISOString(),
  status: { kind: "fresh" },
  installed: [],
  ...patch,
});

let cached: RegistryListing;
let fetched: Promise<RegistryListing>;
let install: (id: string) => Promise<unknown>;

beforeEach(() => {
  cached = listing({ status: { kind: "cached" } });
  fetched = Promise.resolve(listing());
  install = async () => ({ id: harbor.id });
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command === "registry_index") return (args as { refresh: boolean }).refresh ? fetched : cached;
    if (command === "registry_install_theme") return install((args as { id: string }).id);
    return undefined;
  });
});
afterEach(cleanup);

function renderSheet() {
  const onInstalled = vi.fn();
  render(<BrowseThemesSheet mode="dark" themes={[]} onInstalled={onInstalled} onClose={vi.fn()} />);
  return onInstalled;
}

const row = async (name: string) => {
  const title = await screen.findByText(name);
  return within(title.closest("li") as HTMLElement);
};

it("lists the verified themes with when the list was updated", async () => {
  renderSheet();
  expect(await screen.findByText("Updated just now")).toBeInTheDocument();
  expect((await row("Harbor")).getByText("Example, MIT")).toBeInTheDocument();
  expect((await row("Ink")).getByRole("button", { name: "Install" })).toBeEnabled();
});

it("shows the cached list while a first fetch is still loading, and Loading… with nothing cached", async () => {
  fetched = new Promise(() => {});
  cached = listing({ index: null, fetchedAt: null, status: { kind: "cached" } });
  renderSheet();
  expect(await screen.findByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByText("Harbor")).not.toBeInTheDocument();
});

it("keeps the cached list offline, with its date", async () => {
  const fetchedAt = "2026-11-10T08:00:00Z";
  fetched = Promise.resolve(listing({ fetchedAt, status: { kind: "offline", message: "The registry could not be reached: HTTP 404" } }));
  renderSheet();
  const date = new Date(fetchedAt).toLocaleDateString();
  expect(await screen.findByText(`Offline: showing the list from ${date}`)).toBeInTheDocument();
  expect((await row("Harbor")).getByRole("button", { name: "Install" })).toBeEnabled();
});

it("refuses to install anything while the list fails verification", async () => {
  fetched = Promise.resolve(listing({ status: { kind: "refused", message: "The registry's index.json has no valid signature." } }));
  renderSheet();
  const status = await screen.findByText("Couldn't verify the theme list. Nothing new can be installed.");
  expect(status).toHaveClass("theme-browse-status-danger");
  await waitFor(async () => expect((await row("Harbor")).getByRole("button", { name: "Install" })).toBeDisabled());
});

it("searches name, description and author as substrings, CJK included", async () => {
  renderSheet();
  await row("Harbor");
  const search = screen.getByRole("searchbox", { name: "Search themes" });
  fireEvent.change(search, { target: { value: "深夜" } });
  await waitFor(() => expect(screen.queryByText("Harbor")).not.toBeInTheDocument());
  expect(screen.getByText("Ink")).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "nothing like this" } });
  expect(await screen.findByText("No themes match")).toBeInTheDocument();
});

it("shows a blocked theme in red with its reason and no way to install it", async () => {
  const blocked = { id: ink.id, versions: "*", action: "disable", reason: "Phishes.", url: null };
  fetched = Promise.resolve(listing({ blockedOffers: { [ink.id]: blocked } }));
  renderSheet();
  await waitFor(async () => expect((await row("Ink")).getByRole("button", { name: "Blocked" })).toBeDisabled());
  expect((await row("Ink")).getByText("Phishes.")).toHaveClass("theme-browse-blocked");
});

it("keeps a warned theme installable and shows the warning on its row", async () => {
  const warned = { id: ink.id, versions: "*", action: "warn", reason: "Low contrast.", url: null };
  fetched = Promise.resolve(listing({ blockedOffers: { [ink.id]: warned } }));
  renderSheet();
  await waitFor(async () => expect((await row("Ink")).getByRole("button", { name: "Install" })).toBeEnabled());
  expect((await row("Ink")).getByText("Low contrast.")).toHaveClass("theme-browse-warned");
});

it("offers an update for an older registry install and keeps the choice", async () => {
  fetched = Promise.resolve(listing({ installed: [{ id: harbor.id, version: "0.9.0", update: "1.0.0", blocked: null }] }));
  const onInstalled = renderSheet();
  const update = await waitFor(async () => (await row("Harbor")).getByRole("button", { name: "Update to 1.0.0" }));
  fireEvent.click(update);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("registry_install_theme", { id: harbor.id }));
  expect(onInstalled).not.toHaveBeenCalled();
});

it("installs a theme and chooses it, and shows an install error on its row", async () => {
  const onInstalled = renderSheet();
  fireEvent.click((await row("Harbor")).getByRole("button", { name: "Install" }));
  await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(harbor.id));
  install = async () => { throw "The downloaded theme does not match the theme list's checksum."; };
  fireEvent.click((await row("Ink")).getByRole("button", { name: "Install" }));
  expect(await (await row("Ink")).findByText("The downloaded theme does not match the theme list's checksum.")).toBeInTheDocument();
});

it("says a theme the kill switch turned off, or warns about, with its link", () => {
  const entry = { id: ink.id, versions: "*", action: "disable", reason: "Phishes.", url: "https://example.com/1" };
  const { rerender } = render(<ThemeBlockNotice name="Ink" entry={entry} />);
  expect(screen.getByText(/Ink was turned off: Phishes\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
  expect(openUrl).toHaveBeenCalledWith("https://example.com/1");
  rerender(<ThemeBlockNotice name="Ink" entry={{ ...entry, action: "warn", url: null }} />);
  expect(screen.getByText("Ink has a warning: Phishes.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Learn more" })).not.toBeInTheDocument();
});
