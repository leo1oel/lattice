import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { CommandPalette } from "../app/command-palette";
import type { PluginRunHost } from "./plugin-run";
import type { PluginCommand } from "./plugin-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage: (message: unknown) => void = () => {}; },
}));
vi.mock("@tauri-apps/api/event", () => {
  const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  return {
    listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
      return () => handlers.get(event)?.delete(handler);
    }),
    emit: (event: string, payload?: unknown) => handlers.get(event)?.forEach((handler) => handler({ payload })),
  };
});

const search: PluginCommand = {
  pluginId: "dev.example.zotero", pluginName: "Zotero search", commandId: "search", title: "Search Zotero…",
  description: "Find an item and cite it.", input: { kind: "text", placeholder: "Title, author or citation key" },
};
const check: PluginCommand = { pluginId: "dev.example.bib-check", pluginName: "Bib check", commandId: "check", title: "Check bibliography", input: { kind: "none" } };
let listed: PluginCommand[] = [];

const host: PluginRunHost = {
  projectRoot: "/tmp/paper", context: () => null, locale: "en", perform: vi.fn(), openSettings: vi.fn(),
  bibliography: { primary: "refs.bib", read: vi.fn(), rewrite: vi.fn() },
};

function palette(plugins: PluginRunHost | null = host) {
  const props = {
    commands: [{ id: "settings", label: "Open settings", group: "project" as const, run: () => {} }],
    leading: [], files: [], recentFiles: [], papers: [], hasProject: true, knownAuthorName: null,
    onClose: vi.fn(), onChoose: vi.fn(), plugins,
  };
  render(<CommandPalette {...props} />);
  return props;
}

beforeEach(() => {
  listed = [search, check];
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
    if (command === "plugins_commands") return listed;
    if (command === "plugins_run") return new Promise(() => {});
    return null;
  });
});
afterEach(cleanup);

it("lists each enabled plugin command as “Plugin: Command” under Plugins, found by a query", async () => {
  palette();
  const row = await screen.findByRole("option", { name: /Zotero search: Search Zotero…/ });
  expect(row).toHaveTextContent("Find an item and cite it.");
  expect(screen.getByText("Plugins")).toHaveAttribute("data-slot", "picker-section-label");
  fireEvent.change(screen.getByRole("searchbox", { name: "Command palette" }), { target: { value: "bib check" } });
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Bib check: Check bibliography");
});

it("refreshes its rows when plugins change", async () => {
  palette();
  await screen.findByRole("option", { name: /Bib check/ });
  listed = [search];
  emit("plugins-changed");
  await waitFor(() => expect(screen.queryByRole("option", { name: /Bib check/ })).toBeNull());
});

it("turns into the command's input step, and Escape comes back to the list", async () => {
  const props = palette();
  fireEvent.click(await screen.findByRole("option", { name: /Zotero search: Search Zotero…/ }));
  const field = await screen.findByRole("textbox", { name: "Search Zotero…" });
  expect(field).toHaveAttribute("placeholder", "Title, author or citation key");
  expect(screen.getByText("Zotero search")).toHaveClass("plugin-chip");
  expect(props.onChoose).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(await screen.findByRole("searchbox", { name: "Command palette" })).toBeInTheDocument();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("runs a command without input at once, keeping the palette open", async () => {
  const props = palette();
  fireEvent.click(await screen.findByRole("option", { name: /Bib check/ }));
  expect(await screen.findByRole("status")).toHaveTextContent("Running Check bibliography…");
  expect(invoke).toHaveBeenCalledWith("plugins_run", expect.objectContaining({ pluginId: "dev.example.bib-check", commandId: "check" }));
  expect(props.onClose).not.toHaveBeenCalled();
});

it("lists no plugin rows without a host to run them", async () => {
  palette(null);
  await screen.findByRole("option", { name: /Open settings/ });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Plugins")).toBeNull();
});
