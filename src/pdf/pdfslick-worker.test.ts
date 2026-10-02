import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { GlobalWorkerOptions } from "pdfjs-dist";
import { expect, it } from "vitest";

// PDFSlick's module body assigned its own bundled PDF.js worker on import, and
// in production chunks that assignment can run after src/pdf/pdfjs-runtime.ts.
// patches/@pdfslick__core@*.patch removes it; this fails if an upgrade drops
// the patch while the package still carries the assignment. The app bundles
// the ESM `module` build, so load that file rather than the UMD `main`.
it("importing @pdfslick/core leaves the app's PDF.js worker in place", async () => {
  const packageJson = createRequire(import.meta.url).resolve("@pdfslick/core/package.json");
  const esmEntry = pathToFileURL(join(dirname(packageJson), "dist/esm/index.js")).href;
  const sentinel = "lattice-pinned-worker.mjs";
  GlobalWorkerOptions.workerSrc = sentinel;
  await import(/* @vite-ignore */ esmEntry);
  expect(GlobalWorkerOptions.workerSrc).toBe(sentinel);
});

// PDFSlick's print service also bound a capture-phase window keydown listener
// that turned Cmd/Ctrl+P (and Cmd/Ctrl+Shift+P in Chromium) into a print and
// stopped the event, so Quick open and the command palette never opened while
// a PDF was showing. The same patch removes it.
it("leaves Cmd/Ctrl+P to the app instead of PDFSlick's print shortcut", () => {
  const packageJson = createRequire(import.meta.url).resolve("@pdfslick/core/package.json");
  const source = readFileSync(join(dirname(packageJson), "dist/esm/index.js"), "utf8");
  expect(source).toContain("class PDFSlickPrintService");
  expect(source).not.toMatch(/keyCode === \/\* P= \*\/ 80/);
});
