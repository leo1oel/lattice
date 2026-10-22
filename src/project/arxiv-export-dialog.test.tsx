import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArxivExportDialog from "./arxiv-export-dialog";
import { archiveName, formatSize, topLevelNames, type ArxivCheck, type ArxivPackage } from "./arxiv-export";

type Channel = { onmessage: ((message: unknown) => void) | null };
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channel: null as Channel | null, save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;

    constructor() {
      tauri.channel = this;
    }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: tauri.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const PACKAGE: ArxivPackage = {
  rootDocument: "main.tex",
  files: [
    { path: "figures/attention.pdf", bytes: 1_200_000 },
    { path: "main.bbl", bytes: 4_000 },
    { path: "main.tex", bytes: 60_000 },
    { path: "neurips.sty", bytes: 12_000 },
  ],
  totalBytes: 1_276_000,
  sizeLimitBytes: 50_000_000,
  leftOut: ["attention-demo.html", "notes.md", "refs.bib", "slides/", "whiteboard.tldr"],
  figures: ["figures/attention.pdf"],
  missing: [],
  bibliography: { state: "included", file: "main.bbl" },
  comments: {
    removed: true,
    count: 3,
    todos: 1,
    lines: [
      { file: "main.tex", line: 12, text: "TODO: tighten the abstract", todo: true },
      { file: "sections/intro.tex", line: 3, text: "ask Ana about this", todo: false },
    ],
  },
  merged: ["sections/intro.tex"],
  engine: "pdflatex",
  digest: "abc123",
};

const staged: ArxivCheck = { kind: "package", ...PACKAGE };
const checked = (compile: ArxivPackage["compile"] = { outcome: "ok", pages: 9, durationMs: 3_100 }, pack: Partial<ArxivPackage> = {}): ArxivCheck => (
  { kind: "package", ...PACKAGE, ...pack, compile }
);

/** Answer the next check: the staged pack at once, the result when `finish` is called. */
function nextCheck() {
  let finish: (result: ArxivCheck) => void = () => {};
  tauri.invoke.mockImplementationOnce(async (command: string) => {
    expect(command).toBe("check_arxiv_package");
    tauri.channel?.onmessage?.(staged);
    return new Promise<ArxivCheck>((resolve) => { finish = resolve; });
  });
  return { finish: (result: ArxivCheck) => act(async () => { finish(result); }) };
}

/** Answer the next check with `result` straight away. */
function checkReturns(result: ArxivCheck) {
  tauri.invoke.mockImplementationOnce(async () => {
    tauri.channel?.onmessage?.(staged);
    return result;
  });
}

function renderSheet() {
  const props = {
    projectRoot: "/papers/attention",
    projectName: "Understanding Attention",
    save: vi.fn(async () => true),
    build: vi.fn(async () => {}),
    onClose: vi.fn(),
  };
  const view = render(<ArxivExportDialog {...props} />);
  return { props, view };
}

const row = (check: string) => document.querySelector<HTMLElement>(`[data-check="${check}"]`)!;
const exportButton = () => screen.getByRole("button", { name: "Export ZIP" });

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockResolvedValue(undefined);
  tauri.save.mockReset();
  tauri.channel = null;
});
afterEach(cleanup);

describe("Export for arXiv", () => {
  it("saves, shows the staged pack while it builds alone, then is ready with one thing to look at", async () => {
    const check = nextCheck();
    const { props } = renderSheet();
    await screen.findByText("4 files · 1.3 MB · main.bbl, main.tex, neurips.sty, figures/");
    expect(props.save).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("check_arxiv_package", expect.objectContaining({
      projectRoot: "/papers/attention",
      options: { stripComments: true, mergeInputs: true },
    }));
    expect(screen.getByText("Understanding Attention-arxiv.zip")).toBeTruthy();
    expect(screen.getByText("Left out: attention-demo.html, notes.md, refs.bib, slides/ and 1 more")).toBeTruthy();
    expect(row("compile").dataset.state).toBe("running");
    expect(screen.getByRole("status").textContent).toBe("Checking…");
    expect(exportButton()).toHaveProperty("disabled", true);

    await check.finish(checked());
    expect(row("figures").dataset.state).toBe("ok");
    expect(within(row("bibliography")).getByText("Bibliography travels as main.bbl")).toBeTruthy();
    expect(within(row("compile")).getByText("pdfLaTeX · 9 pages · 3.1 s")).toBeTruthy();
    expect(row("comments").dataset.state).toBe("warn");
    expect(within(row("comments")).getByText("3 comment lines, 1 of them a TODO")).toBeTruthy();
    expect(within(row("size")).getByText("1.3 MB of 50 MB")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Ready · 1 to look at");
    expect(exportButton()).toHaveProperty("disabled", false);
  });

  it("lists the comments for review and the files on request", async () => {
    checkReturns(checked());
    renderSheet();
    fireEvent.click(await within(row("comments")).findByRole("button", { name: "Review" }));
    const comments = screen.getByRole("list", { name: "Comments in the source" });
    expect(within(comments).getByText("main.tex:12")).toBeTruthy();
    expect(within(comments).getByText("TODO: tighten the abstract").closest("li")?.dataset.todo).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(within(screen.getByRole("list", { name: "Files in the package" })).getByText("figures/attention.pdf")).toBeTruthy();
  });

  it("blocks the export on a failure, and says why", async () => {
    checkReturns(checked({
      outcome: "failed",
      pages: null,
      durationMs: 900,
      error: { message: "Undefined control sequence.", file: "main.tex", line: 35 },
      log: "! Undefined control sequence.",
    }));
    renderSheet();
    expect(await within(row("compile")).findByText("main.tex:35: Undefined control sequence.")).toBeTruthy();
    expect(row("compile").dataset.state).toBe("fail");
    expect(within(row("compile")).getByRole("button", { name: "Copy log" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 to fix");
    expect(exportButton()).toHaveProperty("disabled", true);
  });

  it("checks again when an option changes, and warns that kept comments will be published", async () => {
    checkReturns(checked());
    renderSheet();
    await within(row("compile")).findByText("pdfLaTeX · 9 pages · 3.1 s");
    const kept = nextCheck();
    fireEvent.click(screen.getByRole("switch", { name: "Remove % comments" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenLastCalledWith("check_arxiv_package", expect.objectContaining({
      options: { stripComments: false, mergeInputs: true },
    })));
    // The previous pack's build no longer speaks for the new one.
    expect(row("compile").dataset.state).toBe("running");
    await kept.finish(checked(undefined, { comments: { ...PACKAGE.comments, removed: false } }));
    expect(within(row("comments")).getByText("Comments will be published")).toBeTruthy();
  });

  it("writes the checked pack where the writer chooses and closes", async () => {
    checkReturns(checked());
    const { props } = renderSheet();
    await waitFor(() => expect(exportButton()).toHaveProperty("disabled", false));
    tauri.save.mockResolvedValue("/Users/me/Desktop/attention-arxiv.zip");
    fireEvent.click(exportButton());
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(tauri.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Understanding Attention-arxiv.zip" }));
    expect(tauri.invoke).toHaveBeenCalledWith("export_arxiv_package", {
      projectRoot: "/papers/attention",
      options: { stripComments: true, mergeInputs: true },
      digest: "abc123",
      zipPath: "/Users/me/Desktop/attention-arxiv.zip",
    });
  });

  it("offers a build when the paper was never built, then checks again", async () => {
    tauri.invoke.mockResolvedValueOnce({ kind: "unbuilt", rootDocument: "paper.tex" });
    const { props } = renderSheet();
    expect(await screen.findByText("Build the paper first")).toBeTruthy();
    expect(exportButton()).toHaveProperty("disabled", true);
    const check = nextCheck();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(props.build).toHaveBeenCalled());
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(2));
    await check.finish(checked());
    expect(screen.getByRole("status").textContent).toBe("Ready · 1 to look at");
  });

  it("stops its test build when it closes", async () => {
    nextCheck();
    const { view } = renderSheet();
    await screen.findByText("4 files · 1.3 MB · main.bbl, main.tex, neurips.sty, figures/");
    view.unmount();
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_arxiv_check", { projectRoot: "/papers/attention" });
  });
});

describe("Export for arXiv helpers", () => {
  it("formats sizes in decimal units, as arXiv states its limit", () => {
    expect(formatSize(400)).toBe("1 kB");
    expect(formatSize(48_200)).toBe("48 kB");
    expect(formatSize(1_940_000)).toBe("1.9 MB");
    expect(formatSize(2_010_000)).toBe("2 MB");
    expect(formatSize(50_000_000)).toBe("50 MB");
    expect(formatSize(1_940_000, "zh-CN")).toBe("1.9 MB");
  });

  it("names the pack's top level, files before folders, and the archive after the project", () => {
    expect(topLevelNames(["figures/a.pdf", "main.tex", "figures/b.pdf", "main.bbl"])).toEqual(["main.bbl", "main.tex", "figures/"]);
    expect(archiveName("A/B: draft")).toBe("A-B- draft-arxiv.zip");
    expect(archiveName("  ")).toBe("paper-arxiv.zip");
  });
});
