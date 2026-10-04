import { describe, expect, it } from "vitest";
import { paletteLeading, paletteSurface } from "./command-palette-leading";
import type { AppCommand } from "./use-app-commands";

const command = (id: string, extra: Partial<AppCommand> = {}): AppCommand => ({ id, label: `Label ${id}`, run: () => {}, ...extra });
const groups = { recent: "Recent", surface: "Here" };

describe("paletteSurface", () => {
  it.each([
    [{ file: "main.tex", paper: false, asset: false }, "source"],
    [{ file: "refs.bib", paper: false, asset: false }, null],
    [{ file: "notes/idea.md", paper: false, asset: false }, "markdown"],
    [{ file: "main.tex", paper: true, asset: false }, "paper"],
    [{ file: "figure.png", paper: false, asset: true }, null],
    [{ file: "data.csv", paper: false, asset: false }, null],
    [{ file: "", paper: false, asset: false }, null],
  ] as const)("reads %j as %s", (open, surface) => {
    expect(paletteSurface(open)).toBe(surface);
  });
});

describe("paletteLeading", () => {
  const available = ["build", "sync-pdf", "cite", "ref", "find", "quick-open", "discover", "goto-line"].map((id) => command(id))
    .concat(command("clean", { recent: false }));

  it("lists the open surface's commands under its group, in their order", () => {
    expect(paletteLeading(available, [], "source", groups).map((item) => [item.id, item.group])).toEqual([
      ["build", "Here"], ["sync-pdf", "Here"], ["cite", "Here"], ["ref", "Here"],
    ]);
    expect(paletteLeading(available, [], "paper", groups).map((item) => item.id)).toEqual(["find", "discover", "quick-open"]);
    expect(paletteLeading(available, [], null, groups)).toEqual([]);
  });

  it("leads with the last three recent commands and lists each command once", () => {
    const leading = paletteLeading(available, ["cite", "goto-line", "find", "discover"], "source", groups);
    expect(leading.map((item) => [item.id, item.group])).toEqual([
      ["cite", "Recent"], ["goto-line", "Recent"], ["find", "Recent"],
      ["build", "Here"], ["sync-pdf", "Here"], ["ref", "Here"],
    ]);
    expect(leading[0]).toMatchObject({ label: "Label cite" });
  });

  it("never brings back a recent command that is unavailable now or opts out of being recent", () => {
    const leading = paletteLeading(available, ["stop-build", "clean", "removed-in-an-update", "goto-line"], null, groups);
    expect(leading.map((item) => item.id)).toEqual(["goto-line"]);
  });
});
