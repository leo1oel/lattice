// The tutorial project's own PDF, for scenes that show it: draw.mjs serves it
// to the mock-backend page (?pdf=), and the GPUI parity harness
// (gpui/parity/) also opens it in the GPUI app.
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The bundled tutorial project, as the app copies it out. */
export const TUTORIAL_TEMPLATE = join(repo, "src-tauri/templates/tutorial");

/** Serves one PDF with CORS, for the mock-backend page's ?pdf=. */
export function servePdf(path) {
  const pdf = readFileSync(path);
  return new Promise((resolve) => {
    const server = http.createServer((_, res) => { res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/pdf" }); res.end(pdf); });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/main.pdf`, close: () => server.close() }));
  });
}
