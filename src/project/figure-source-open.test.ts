import { beforeEach, describe, expect, it, vi } from "vitest";
import { figureEntryBeside, isDrawingFile, openDrawingOf, openFigureSource } from "./figure-source-open";

const { invoke, notifyError } = vi.hoisted(() => ({ invoke: vi.fn(), notifyError: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../app-utils", () => ({ toMessage: (reason: unknown) => String(reason) }));
vi.mock("../telemetry/app-notify", () => ({ notifyError }));

const opened = () => invoke.mock.calls.filter(([command]) => command === "open_figure_source").map(([, args]) => args);

describe("opening a figure's source", () => {
  beforeEach(() => { invoke.mockReset(); notifyError.mockReset(); });

  it("leaves what happens to the host, and says when it fails", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await openFigureSource("figures/a.reactio");
    expect(opened()).toEqual([{ path: "figures/a.reactio" }]);
    expect(notifyError).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce(new Error("a.reactio could not be found."));
    await openFigureSource("a.reactio");
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it("opens the drawing an entry names, skipping files that are not figures", async () => {
    invoke.mockImplementation(async (command: string, args: { path: string }) => {
      if (command === "open_figure_source") return true;
      if (args.path === "figures/a.tex") return "% editable-figure source: a.reactio\n";
      if (args.path === "plain.tex") return "\\section{x}";
      throw new Error("missing");
    });
    await expect(openDrawingOf("missing.tex", "plain.tex", "figures/a.tex")).resolves.toBe(true);
    expect(opened()).toEqual([{ path: "figures/a.reactio" }]);
    await expect(openDrawingOf("plain.tex")).resolves.toBe(false);
  });

  it("knows drawings for the tree, leaving SVG to Lattice's preview", () => {
    expect(isDrawingFile("f/a.REACTIO")).toBe(true);
    expect(isDrawingFile("f/a.drawio")).toBe(true);
    expect(isDrawingFile("f/a.svg")).toBe(false);
    expect(isDrawingFile("f/a.tex")).toBe(false);
  });

  it("finds a figure's entry from its .tex or .pdf when a drawing lies beside it", () => {
    const paths = ["f/Document_1.tex", "f/Document_1.pdf", "f/Document 1.reactio", "f/x.tex", "main.tex", "f/sub/x.reactio"];
    expect(figureEntryBeside("f/Document_1.pdf", paths)).toBe("f/Document_1.tex");
    expect(figureEntryBeside("f/Document_1.tex", paths)).toBe("f/Document_1.tex");
    expect(figureEntryBeside("f/x.tex", paths)).toBeNull();
    expect(figureEntryBeside("main.tex", paths)).toBeNull();
    expect(figureEntryBeside("f/Document 1.reactio", paths)).toBeNull();
  });
});
