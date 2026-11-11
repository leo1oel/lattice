// The tutorial project's own PDF, for scenes that show it: draw.mjs serves it
// to the mock-backend page (?pdf=), and the GPUI parity harness
// (gpui/parity/) also opens it in the GPUI app.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The bundled tutorial project, as the app copies it out. */
export const TUTORIAL_TEMPLATE = join(repo, "src-tauri/templates/tutorial");

/**
 * Builds the tutorial in a scratch copy at `dir` with latexmk (the NeurIPS
 * style it asks for copied beside it, as the app's template set provides
 * it). Returns the PDF's path, or null when latexmk is missing or made none.
 */
export function buildTutorialPdf(dir) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(TUTORIAL_TEMPLATE, dir, { recursive: true });
  cpSync(join(repo, "src-tauri/templates/neurips-2026/neurips_2026.sty"), join(dir, "neurips.sty"));
  try {
    execFileSync("latexmk", ["-pdf", "-interaction=nonstopmode", "main.tex"], { cwd: dir, stdio: "ignore", timeout: 300_000 });
  } catch {
    // A build with errors can still write a PDF; only a missing one counts.
  }
  const pdf = join(dir, "main.pdf");
  return existsSync(pdf) ? pdf : null;
}

/** Serves one PDF with CORS, for the mock-backend page's ?pdf=. */
export function servePdf(path) {
  const pdf = readFileSync(path);
  return new Promise((resolve) => {
    const server = http.createServer((_, res) => { res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/pdf" }); res.end(pdf); });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/main.pdf`, close: () => server.close() }));
  });
}
