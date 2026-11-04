/**
 * The project the demo opens: the bundled tutorial (src-tauri/templates
 * /tutorial) as scripts/web-demo-content.mjs's `demoTutorial` composes it for
 * the compiled PDF, so the source the visitor edits is the source that PDF
 * came from. Its figures are Lattice's own drawings (content/figures/), the
 * edits in content/overrides.json say so, and neurips.sty sits beside
 * main.tex as in a new tutorial. The tutorial's own figures/ folder is never
 * globbed, so its reproduced figures are not in the build.
 */
import { filesUnder, type ProjectFiles } from "../mock-backend/project";
import overrides from "./content/overrides.json";
import neuripsStyle from "../../src-tauri/templates/neurips-2026/neurips_2026.sty?raw";
import attribution from "./content/figures/ATTRIBUTION.md?raw";
import scaledDotProduct from "./content/figures/scaled-dot-product-attention.png?url";
import multiHead from "./content/figures/multi-head-attention.png?url";
import sideBySide from "./content/figures/attention-figure-2.pdf?url";

const tutorialText = import.meta.glob<string>(
  ["../../src-tauri/templates/tutorial/**/*", "!**/figures/**"],
  { query: "?raw", import: "default", eager: true },
);

const FIGURES: Array<[string, string]> = [
  ["figures/scaled-dot-product-attention.png", scaledDotProduct],
  ["figures/multi-head-attention.png", multiHead],
  ["figures/attention-figure-2.pdf", sideBySide],
];

export async function demoTutorialFiles(): Promise<ProjectFiles> {
  const files: ProjectFiles = new Map(filesUnder("tutorial", tutorialText));
  for (const { file, find, replace } of overrides.edits) {
    const text = String(files.get(file) ?? "");
    if (text.split(find).length !== 2) throw new Error(`The demo's ${file} no longer holds the text content/overrides.json edits.`);
    files.set(file, text.replace(find, () => replace));
  }
  files.set("figures/ATTRIBUTION.md", attribution);
  await Promise.all(FIGURES.map(async ([path, url]) => {
    files.set(path, new Uint8Array(await (await fetch(url)).arrayBuffer()));
  }));
  files.set("neurips.sty", neuripsStyle.replace("\\ProvidesPackage{neurips_2026}", "\\ProvidesPackage{neurips}"));
  return files;
}
