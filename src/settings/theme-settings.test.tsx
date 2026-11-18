import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { type AppearanceSettings, loadAppearance } from "./app-settings";
import { ThemeSettingsGroup } from "./theme-settings";
import type { ThemeInfo } from "./themes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const variant = (appearance: "light" | "dark", accent: string | null) => ({
  id: appearance, name: appearance, appearance, window: "#faf4ed", chrome: "#f2e9e1", panel: "#fffaf3", text: "#575279", accent,
});
const rose: ThemeInfo = {
  id: "app.lattice.rose-pine", name: "Rosé Pine", version: "1.0.0", author: "Rosé Pine", license: "MIT",
  description: "All natural pine, faux fur and a bit of soho vibes.", source: "bundled",
  variants: [variant("light", "#907aa9"), variant("dark", "#c4a7e7")],
  blocked: null,
};
const mine: ThemeInfo = { ...rose, id: "dev.example.mine", name: "Mine", description: "", source: "installed" };
let themes: ThemeInfo[];

beforeEach(() => {
  themes = [rose, mine];
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command === "themes_list") return themes;
    if (command === "themes_install_file") return mine;
    if (command === "themes_fit_accent") return { color: (args as { color: string }).color, ratio: 5 };
    return undefined;
  });
});
afterEach(cleanup);

function renderGroup(patch: Partial<AppearanceSettings> = {}) {
  const setAppearance = vi.fn();
  const appearance = { ...loadAppearance(), ...patch };
  render(
    <ThemeSettingsGroup
      appearance={appearance}
      setAppearance={setAppearance}
      themePreference="light"
      setThemePreference={vi.fn()}
      theme="light"
      windowBacking="unsupported"
    />,
  );
  return setAppearance;
}

const palette = async () => within(await screen.findByRole("radiogroup", { name: "Palette" }));

it("lists Lattice's own palette and every theme, and choosing one takes its accent over the default", async () => {
  const setAppearance = renderGroup();
  const tiles = await palette();
  expect(tiles.getAllByRole("radio").map((tile) => tile.getAttribute("aria-label"))).toEqual(["Lattice", "Rosé Pine", "Mine"]);
  expect(tiles.getByRole("radio", { name: "Lattice" })).toBeChecked();
  fireEvent.click(tiles.getByRole("radio", { name: "Rosé Pine" }));
  expect(setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "app.lattice.rose-pine", accent: "theme" }));
});

it("keeps an accent the writer picked when a theme is chosen (L13)", async () => {
  const setAppearance = renderGroup({ accent: "blue" });
  fireEvent.click((await palette()).getByRole("radio", { name: "Rosé Pine" }));
  expect(setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "app.lattice.rose-pine", accent: "blue" }));
});

it("offers the theme's accent and stops the tints while a theme is in effect", async () => {
  renderGroup({ theme: "app.lattice.rose-pine", accent: "theme" });
  await screen.findByText(rose.description);
  const accents = within(screen.getByRole("radiogroup", { name: "Accent" }));
  expect(accents.getByRole("radio", { name: "Theme default" })).toBeChecked();
  expect(accents.getByRole("radio", { name: "Theme default" }).querySelector(".theme-swatch-fill")).toHaveStyle({ background: "#907aa9" });
  for (const tint of within(screen.getByRole("radiogroup", { name: "Tint" })).getAllByRole("radio")) expect(tint).toBeDisabled();
  expect(screen.getByText("Set by the theme")).toBeInTheDocument();
});

it("installs a theme file and chooses it", async () => {
  vi.mocked(open).mockResolvedValueOnce("/Users/me/Downloads/mine.lattice-theme.json");
  const setAppearance = renderGroup();
  await palette();
  fireEvent.click(screen.getByRole("button", { name: "Install from file…" }));
  await waitFor(() => expect(setAppearance).toHaveBeenCalledWith(expect.objectContaining({ theme: "dev.example.mine" })));
  expect(invoke).toHaveBeenCalledWith("themes_install_file", { path: "/Users/me/Downloads/mine.lattice-theme.json" });
});

it("shows why a theme file could not be installed", async () => {
  vi.mocked(open).mockResolvedValueOnce("/tmp/bad.json");
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "themes_list") return themes;
    throw "The theme file is larger than 256 KiB.";
  });
  renderGroup();
  await palette();
  fireEvent.click(screen.getByRole("button", { name: "Install from file…" }));
  expect(await screen.findByText("The theme file is larger than 256 KiB.")).toBeInTheDocument();
});

it("offers to remove only a theme that was installed", async () => {
  renderGroup({ theme: "app.lattice.rose-pine" });
  await screen.findByText(rose.description);
  expect(screen.queryByRole("button", { name: "Remove theme" })).toBeNull();
  cleanup();
  renderGroup({ theme: "dev.example.mine" });
  expect(await screen.findByRole("button", { name: "Remove theme" })).toBeInTheDocument();
});

it("says in the Palette row when the chosen theme was turned off by the registry", async () => {
  themes = [rose, { ...mine, blocked: { id: mine.id, versions: "*", action: "disable", reason: "Phishes.", url: null } }];
  renderGroup({ theme: mine.id });
  expect(await screen.findByText("Mine was turned off: Phishes.")).toBeInTheDocument();
  expect((await palette()).getByRole("radio", { name: "Mine" })).toBeChecked();
});
