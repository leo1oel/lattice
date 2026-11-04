#!/usr/bin/env node
/**
 * The website demo's prepared content (tools/web-demo/content/compiled/): the
 * tutorial as the demo opens it, compiled ahead of time, since a static page
 * has no TeX. Needs TeX Live (latexmk, pdflatex, synctex) and poppler
 * (pdftoppm, pdfseparate); run it after changing the tutorial or the demo's
 * figures, then commit what it writes:
 *
 *   node scripts/web-demo-content.mjs
 *
 * It draws the figures (content/figures/attention-figures.tex) into the PNGs
 * and PDF the tutorial includes, composes the demo's tutorial (demoTutorial
 * below, which tools/web-demo/demo-project.ts mirrors in the page), builds it
 * as Lattice does (latexmk, pdfLaTeX, SyncTeX), and writes:
 *
 *   main.pdf      the PDF the demo shows
 *   build.json    the build's log, warnings and page count
 *   synctex.json  where each main.tex line is typeset, from `synctex view`
 *   inputs.json   the hash of what the PDF was built from;
 *                 web-demo-content.test.ts fails when the tutorial has moved on
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { capture, isMain, projectRoot, readJson, sha256, walkFiles, writeJson } from "./lib/util.mjs";

const TUTORIAL = path.join(projectRoot, "src-tauri/templates/tutorial");
const CONTENT = path.join(projectRoot, "tools/web-demo/content");
const COMPILED = path.join(CONTENT, "compiled");
const FIGURES = ["scaled-dot-product-attention.png", "multi-head-attention.png", "attention-figure-2.pdf", "ATTRIBUTION.md"];
/** The files a build of main.tex reads from the project: what inputs.json hashes. */
const BUILD_INPUTS = /^(?:main\.tex|references\.bib|neurips\.sty|figures\/.+\.(?:png|pdf))$/;
/** Fixed dates in the PDF, so a rebuild of the same inputs writes the same bytes. */
const SOURCE_DATE_EPOCH = "1767225600";

/**
 * The tutorial as the demo opens it, by project-relative path: the bundled
 * one with the demo's edits (content/overrides.json), its figures replaced
 * by Lattice's own, and the NeurIPS style beside it as a new tutorial gets
 * it (src-tauri/src/project/create.rs).
 */
export function demoTutorial() {
  const files = new Map();
  for (const file of walkFiles(TUTORIAL)) {
    const relative = path.relative(TUTORIAL, file).split(path.sep).join("/");
    if (!relative.startsWith("figures/")) files.set(relative, readFileSync(file));
  }
  for (const { file, find, replace } of readJson(path.join(CONTENT, "overrides.json")).edits) {
    const text = files.get(file)?.toString("utf8") ?? "";
    if (text.split(find).length !== 2) throw new Error(`content/overrides.json: ${file} must hold ${JSON.stringify(find)} exactly once`);
    files.set(file, Buffer.from(text.replace(find, () => replace)));
  }
  for (const figure of FIGURES) files.set(`figures/${figure}`, readFileSync(path.join(CONTENT, "figures", figure)));
  const style = readFileSync(path.join(projectRoot, "src-tauri/templates/neurips-2026/neurips_2026.sty"), "utf8")
    .replace("\\ProvidesPackage{neurips_2026}", "\\ProvidesPackage{neurips}");
  files.set("neurips.sty", Buffer.from(style));
  return files;
}

/** The hash of the files a build of the demo's tutorial reads. */
export function buildInputsHash(files = demoTutorial()) {
  const hash = [...files].filter(([file]) => BUILD_INPUTS.test(file)).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, bytes]) => `${file}\0${sha256(bytes)}`).join("\n");
  return sha256(hash);
}

const tool = (command, args, cwd) => capture(command, args, {
  cwd, env: { ...process.env, SOURCE_DATE_EPOCH, FORCE_SOURCE_DATE: "1" }, maxBuffer: 64 << 20,
});

/** The TikZ drawings, rendered into the PNGs main.tex includes and the side-by-side PDF. */
function drawFigures(scratch) {
  const dir = path.join(scratch, "figures");
  mkdirSync(dir);
  copyFileSync(path.join(CONTENT, "figures/attention-figures.tex"), path.join(dir, "attention-figures.tex"));
  tool("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "attention-figures.tex"], dir);
  const pdf = path.join(dir, "attention-figures.pdf");
  for (const [page, name] of [[1, "scaled-dot-product-attention"], [2, "multi-head-attention"]]) {
    tool("pdftoppm", ["-png", "-r", "300", "-singlefile", "-f", String(page), "-l", String(page), pdf, path.join(CONTENT, "figures", name)], dir);
  }
  tool("pdfseparate", ["-f", "3", "-l", "3", pdf, path.join(CONTENT, "figures/attention-figure-2.pdf")], dir);
}

/** The warnings TeX's log reports, as the build's diagnostics carry them. */
function warnings(log) {
  const found = [];
  for (const match of log.matchAll(/^(?:LaTeX|Package \w+) Warning: ([\s\S]+?)(?: on input line (\d+))?\.\n/gm)) {
    found.push({ level: "warning", message: match[1].replace(/\n(?:\(\w+\))?\s*/g, " ").trim(), file: "main.tex", ...match[2] ? { line: Number(match[2]) } : {} });
  }
  for (const match of log.matchAll(/^(Overfull|Underfull) \\hbox \(([^)]+)\) in paragraph at lines (\d+)--(\d+)/gm)) {
    found.push({ level: "warning", message: match[0], file: "main.tex", line: Number(match[3]) });
  }
  return found;
}

/**
 * Where each line of main.tex lands, as `synctex view` answers: its page and
 * the rectangle to highlight (PDF points from the page's top left), the
 * first result's box, or a word-sized marker on its point when it has none.
 */
function forwardMap(dir, lineCount) {
  const lines = {};
  for (let line = 1; line <= lineCount; line += 1) {
    const output = tool("synctex", ["view", "-i", `${line}:0:main.tex`, "-o", "main.pdf"], dir);
    const result = output.split("SyncTeX result begin")[1]?.split("\nOutput:")[1];
    if (!result) continue;
    const field = (name) => Number(new RegExp(`^${name}:(.+)$`, "m").exec(result)?.[1]);
    const page = field("Page");
    if (!page) continue;
    const [h, v, width, height] = [field("h"), field("v"), field("W"), field("H")];
    const round = (value) => Math.round(value * 100) / 100;
    lines[line] = width > 0 && height > 0
      ? [page, round(h), round(v - height), round(width), round(height)]
      : [page, round(field("x")), round(field("y") - 12), 24, 12];
  }
  return lines;
}

function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "lattice-web-demo-content-"));
  try {
    drawFigures(scratch);
    const files = demoTutorial();
    const project = path.join(scratch, "Understanding Attention");
    for (const [file, bytes] of files) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), bytes);
    }
    const started = Date.now();
    tool("latexmk", ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-file-line-error", "main.tex"], project);
    const durationMs = Date.now() - started;
    mkdirSync(COMPILED, { recursive: true });
    copyFileSync(path.join(project, "main.pdf"), path.join(COMPILED, "main.pdf"));
    // The log names the scratch folder the build ran in, which the demo's
    // project has none of, and paths under this machine's home folder (a
    // user TeX tree), which a public page must not show. TeX wraps its log at
    // 79 columns, so a path can break anywhere with a newline.
    const wrapped = (text) => new RegExp(text.split("").map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\n?"), "g");
    const log = readFileSync(path.join(project, "main.log"), "latin1")
      .replace(wrapped(project), ".").replace(wrapped(scratch), ".").replace(wrapped(os.homedir()), "~");
    const pages = Number(/Output written on main\.pdf \((\d+) pages?/.exec(log)?.[1]) || null;
    writeJson(path.join(COMPILED, "build.json"), { pages, durationMs, warnings: warnings(log), log });
    const lineCount = files.get("main.tex").toString("utf8").split("\n").length;
    // One line per source line: [page, x, y, width, height].
    const map = Object.entries(forwardMap(project, lineCount)).map(([line, box]) => `    "${line}": ${JSON.stringify(box)}`);
    writeFileSync(path.join(COMPILED, "synctex.json"), `{\n  "file": "main.tex",\n  "lines": {\n${map.join(",\n")}\n  }\n}\n`);
    writeJson(path.join(COMPILED, "inputs.json"), { sha256: buildInputsHash(files) });
    console.log(`Wrote ${readdirSync(COMPILED).join(", ")} into ${path.relative(projectRoot, COMPILED)} (${pages} pages).`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) main();
