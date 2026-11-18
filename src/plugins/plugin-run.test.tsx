import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import PluginRun, { type PluginRunHost } from "./plugin-run";
import type { PluginCommand, PluginResult } from "./plugin-ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage: (message: unknown) => void = () => {}; },
}));

const search: PluginCommand = {
  pluginId: "dev.example.zotero", pluginName: "Zotero search", commandId: "search", title: "Search Zotero…",
  description: "Find an item and cite it.", input: { kind: "text", placeholder: "Title, author or citation key" },
};
const check: PluginCommand = { pluginId: "dev.example.bib-check", pluginName: "Bib check", commandId: "check", title: "Check bibliography", input: { kind: "none" } };

type Run = { args: Record<string, unknown>; resolve: (value: PluginResult) => void; reject: (reason: unknown) => void };
let runs: Run[] = [];
const BIB = "@article{vaswani2017,\n  title = {Attention},\n}\n";

function host(overrides: Partial<PluginRunHost> = {}): PluginRunHost {
  return {
    projectRoot: "/tmp/paper",
    context: () => ({ activeFile: "main.tex", cursor: { file: "main.tex", position: { line: 3, column: 5 } } }),
    locale: "en",
    perform: vi.fn(),
    bibliography: { primary: "refs.bib", read: vi.fn(async () => BIB), rewrite: vi.fn(async () => true) },
    openSettings: vi.fn(),
    ...overrides,
  };
}

function mount(command: PluginCommand, runHost = host()) {
  const props = { command, host: runHost, returnFocus: null, onBack: vi.fn(), onClose: vi.fn() };
  render(<PluginRun {...props} />);
  return props;
}

const lastRun = () => runs[runs.length - 1];
async function answer(result: PluginResult) {
  await waitFor(() => expect(runs.length).toBeGreaterThan(0));
  await act(async () => lastRun().resolve(result));
}

beforeEach(() => {
  runs = [];
  vi.mocked(invoke).mockReset().mockImplementation((command, args) => {
    if (command === "plugins_run") {
      return new Promise((resolve, reject) => { runs.push({ args: args as Record<string, unknown>, resolve, reject }); });
    }
    return Promise.resolve(null);
  });
});
afterEach(cleanup);

describe("the input step", () => {
  it("shows the plugin's chip and placeholder, runs on Return with the text and the page's context", async () => {
    mount(search);
    expect(screen.getByText("Zotero search")).toHaveClass("plugin-chip");
    const field = screen.getByRole("textbox", { name: "Search Zotero…" });
    expect(field).toHaveAttribute("placeholder", "Title, author or citation key");
    fireEvent.change(field, { target: { value: "attention" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(lastRun().args).toMatchObject({
      pluginId: "dev.example.zotero", commandId: "search", input: "attention", projectRoot: "/tmp/paper", locale: "en",
      context: { activeFile: "main.tex", cursor: { file: "main.tex", position: { line: 3, column: 5 } } },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Running Search Zotero……");
  });

  it("goes back to the palette on Escape", () => {
    const props = mount(search);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(props.onBack).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("a run", () => {
  it("starts at once without input, shows the latest progress, and Escape cancels it", async () => {
    const props = mount(check);
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(lastRun().args.input).toBeNull();
    const channel = lastRun().args.onEvent as { onmessage: (event: unknown) => void };
    act(() => channel.onmessage({ type: "progress", message: "Reading refs.bib" }));
    expect(screen.getByRole("status")).toHaveTextContent("Reading refs.bib");
    fireEvent.keyDown(screen.getByRole("status"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
    cleanup();
    expect(invoke).toHaveBeenCalledWith("plugins_cancel", { runId: lastRun().args.runId });
  });
});

describe("results", () => {
  it("lists items with their muted lines and badges; Return runs the first action, the others are buttons", async () => {
    const runHost = host();
    const props = mount(check, runHost);
    await answer({
      kind: "items", summary: "2 matches", items: [
        { id: "a", title: "Attention Is All You Need", subtitle: "Vaswani et al., 2017", detail: "NeurIPS", badges: ["In bibliography"],
          actions: [{ type: "insertCitation", key: "vaswani2017" }, { type: "copy", text: "vaswani2017", title: "Copy key" }] },
        { id: "b", title: "BERT", badges: [], actions: [{ type: "openUrl", url: "https://arxiv.org/abs/1810.04805" }] },
      ],
    });
    expect(screen.getByText("Bib check")).toBeInTheDocument();
    expect(screen.getByText("2 matches")).toBeInTheDocument();
    expect(screen.getByText("Vaswani et al., 2017")).toHaveClass("plugin-row-muted");
    expect(screen.getByText("In bibliography")).toHaveAttribute("data-slot", "badge");
    expect(screen.getByRole("button", { name: "Copy key" })).toBeInTheDocument();
    const list = screen.getByRole("listbox", { name: "Results" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.queryByRole("button", { name: "Copy key" })).toBeNull();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(props.onClose).toHaveBeenCalled();
    expect(runHost.perform).toHaveBeenCalledWith({ type: "openUrl", url: "https://arxiv.org/abs/1810.04805" });
  });

  it("groups diagnostics by file; Return reveals, a fix is a button", async () => {
    const runHost = host();
    mount(check, runHost);
    await answer({
      kind: "diagnostics", items: [
        { id: "1", file: "refs.bib", line: 4, severity: "error", code: "duplicate-key", message: "Duplicate key vaswani2017", fixes: [] },
        { id: "2", file: "other.bib", line: 9, severity: "info", message: "Unused entry", fixes: [] },
        { id: "3", file: "refs.bib", line: 12, severity: "warning", code: "missing-field", message: "Missing year",
          fixes: [{ type: "reveal", file: "refs.bib", line: 12, title: "Show" }] },
      ],
    });
    const headers = [...document.querySelectorAll(".plugin-file-header")].map((node) => node.textContent);
    expect(headers).toEqual(["refs.bib", "other.bib"]);
    expect(screen.getByText("line 4 · duplicate-key")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Error" })).toHaveAttribute("data-severity", "error");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Duplicate key"), expect.stringContaining("Missing year"), expect.stringContaining("Unused entry"),
    ]);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Problems" }), { key: "Enter" });
    expect(runHost.perform).toHaveBeenCalledWith({ type: "reveal", file: "refs.bib", line: 4 });
  });

  it("says when nothing was found or nothing is wrong", async () => {
    mount(check);
    await answer({ kind: "items", items: [] });
    expect(screen.getByText("Nothing found")).toBeInTheDocument();
    cleanup();
    runs = [];
    mount(check);
    await answer({ kind: "diagnostics", items: [] });
    expect(screen.getByText("No problems found")).toBeInTheDocument();
  });

  it("draws a message's Markdown without its HTML, and opens only web links", async () => {
    const runHost = host();
    mount(check, runHost);
    await answer({ kind: "message", markdown: "# Done\n\n**3** entries checked. <img src=x onerror=alert(1)> [docs](https://example.org) [local](file:///etc/passwd)" });
    expect(screen.getByText("3").tagName).toBe("STRONG");
    expect(document.querySelector(".plugin-markdown img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["docs"]);
    fireEvent.click(screen.getByRole("link", { name: "docs" }));
    expect(runHost.perform).toHaveBeenCalledWith({ type: "openUrl", url: "https://example.org" });
  });
});

describe("errors", () => {
  it("names a plugin's own error, and offers Settings for a plugin that needs review", async () => {
    mount(check);
    await waitFor(() => expect(runs).toHaveLength(1));
    await act(async () => lastRun().reject({ code: "plugin", message: "Zotero isn't running." }));
    expect(screen.getByText("Zotero isn't running.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    cleanup();
    runs = [];
    const runHost = host();
    const props = mount(check, runHost);
    await waitFor(() => expect(runs).toHaveLength(1));
    await act(async () => lastRun().reject({ code: "needsReview" }));
    expect(screen.getByText("This plugin asks for new permissions. Review them in Settings › Plugins.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(runHost.openSettings).toHaveBeenCalled();
  });

  it("localizes the host's codes", async () => {
    mount(check);
    await waitFor(() => expect(runs).toHaveLength(1));
    await act(async () => lastRun().reject({ code: "timeout" }));
    expect(screen.getByText("The plugin didn’t finish within 2 minutes.")).toBeInTheDocument();
  });
});

describe("bibliography actions", () => {
  it("shows a new entry and adds it only once the writer confirms, through the app's write", async () => {
    const runHost = host();
    const props = mount(check, runHost);
    const bibtex = "@book{knuth1984, title = {The TeXbook}}";
    await answer({ kind: "items", items: [{ id: "k", title: "The TeXbook", badges: [], actions: [{ type: "addBibEntry", bibtex }] }] });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Add this entry to refs.bib?" })).toBeInTheDocument();
    expect(screen.getByText(bibtex)).toBeInTheDocument();
    expect(runHost.bibliography.rewrite).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    const [path, change] = vi.mocked(runHost.bibliography.rewrite).mock.calls[0];
    expect(path).toBe("refs.bib");
    expect(change(BIB)).toBe(`${BIB}\n${bibtex}\n`);
  });

  it("shows the entry as it is and as it would be, and Cancel goes back to the results", async () => {
    const runHost = host();
    mount(check, runHost);
    const after = "@article{vaswani2017,\n  title = {Attention Is All You Need},\n}";
    await answer({ kind: "diagnostics", items: [{ id: "1", file: "refs.bib", line: 1, severity: "warning", message: "Short title",
      fixes: [{ type: "replaceBibEntry", key: "vaswani2017", bibtex: after }] }] });
    fireEvent.click(screen.getByRole("button", { name: "Update entry" }));
    await screen.findByRole("heading", { name: "Update “vaswani2017” in refs.bib?" });
    await waitFor(() => expect(document.querySelector('[data-change="removed"]')?.textContent).toBe(BIB.trim()));
    expect(document.querySelector('[data-change="added"]')?.textContent).toBe(after);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("listbox", { name: "Problems" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update entry" }));
    const confirm = await screen.findAllByRole("button", { name: "Update entry" });
    await waitFor(() => expect(confirm[confirm.length - 1]).toBeEnabled());
    fireEvent.click(confirm[confirm.length - 1]);
    await waitFor(() => expect(runHost.bibliography.rewrite).toHaveBeenCalled());
    const [, change] = vi.mocked(runHost.bibliography.rewrite).mock.calls[0];
    expect(change(BIB)).toBe(`${after}\n`);
  });
});
