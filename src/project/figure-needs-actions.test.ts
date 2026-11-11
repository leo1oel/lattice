import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeFigureNeeds, includesEntry } from "./figure-needs-actions";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));

const files: Record<string, string> = {
  "chapters/one.tex": "\\input{chapters/two}\n",
  "chapters/two.tex": "\\begin{figure}\\input{figures/scheme}\\end{figure}\n",
  "loop.tex": "\\input{loop}\n",
};
const read = (path: string) => (path in files ? Promise.resolve(files[path]) : Promise.reject(new Error("missing")));

describe("whether a document includes a figure", () => {
  it("finds it in the document or through the files it includes", async () => {
    expect(await includesEntry("main.tex", "\\input{figures/scheme}", "figures/scheme.tex", read)).toBe(true);
    expect(await includesEntry("main.tex", "\\include{chapters/one}", "figures/scheme.tex", read)).toBe(true);
  });
  it("is false for a commented include, another figure, or a loop", async () => {
    expect(await includesEntry("main.tex", "% \\input{figures/scheme}", "figures/scheme.tex", read)).toBe(false);
    expect(await includesEntry("main.tex", "\\input{figures/other}", "figures/scheme.tex", read)).toBe(false);
    expect(await includesEntry("main.tex", "\\input{loop}", "figures/scheme.tex", read)).toBe(false);
  });
});

const entry = (name: string, packages: string) => `% editable-figure source: ${name}.svg\n% editable-figure packages: ${packages}\n\\includegraphics{${name}.pdf}\n`;

/** A project on disk behind the host's read and write commands; writes are recorded. */
function host(disk: Record<string, string>) {
  const writes: { path: string; content: string; baseContent: string }[] = [];
  invoke.mockImplementation(async (command: string, args: { path: string; content: string; baseContent: string }) => {
    if (command === "read_project_file") {
      if (args.path in disk) return disk[args.path];
      throw new Error("missing");
    }
    if (command === "write_project_file") {
      writes.push({ path: args.path, content: args.content, baseContent: args.baseContent });
      disk[args.path] = args.content;
      return undefined;
    }
    throw new Error(`unexpected ${command}`);
  });
  return writes;
}

describe("completing a root's preamble for its entries", () => {
  beforeEach(() => { invoke.mockReset(); });

  it("runs one completion at a time, so a second reads what the first wrote", async () => {
    const disk = {
      "main.tex": "\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n\\begin{document}\n\\input{figures/a}\n\\input{figures/b}\n\\end{document}\n",
      "figures/a.tex": entry("a", "graphicx tikz"),
      "figures/b.tex": entry("b", "graphicx chemnum"),
    };
    const writes = host(disk);
    await Promise.all([
      completeFigureNeeds("figures/a.tex", disk["figures/a.tex"], "/p", ["main.tex"]),
      completeFigureNeeds("figures/b.tex", disk["figures/b.tex"], "/p", ["main.tex"]),
    ]);
    expect(writes).toHaveLength(2);
    expect(writes[1].baseContent).toBe(writes[0].content);
    expect(disk["main.tex"]).toContain("\\usepackage{tikz}");
    expect(disk["main.tex"]).toContain("\\usepackage{chemnum}");
  });

  it("counts what a file loaded by a preamble file sets, and writes nothing", async () => {
    const disk = {
      "main.tex": "\\documentclass{article}\n\\input{preamble}\n\\begin{document}\n\\input{figures/a}\n\\end{document}\n",
      "preamble.tex": "\\input{settings}\n",
      "settings.tex": "\\usepackage{graphicx,tikz}\n\\graphicspath{{img/}{figures/}}\n",
      "figures/a.tex": entry("a", "graphicx tikz"),
    };
    const writes = host(disk);
    await completeFigureNeeds("figures/a.tex", disk["figures/a.tex"], "/p", ["main.tex"]);
    expect(writes).toEqual([]);
  });
});
