import { GlobalWorkerOptions } from "pdfjs-dist";
import { expect, it } from "vitest";

// PDFSlick's module body assigned its own bundled PDF.js worker on import, and
// in production chunks that assignment can run after src/pdf/pdfjs-runtime.ts.
// patches/@pdfslick__core@*.patch removes it; this fails if an upgrade drops
// the patch while the package still carries the assignment.
it("importing @pdfslick/core leaves the app's PDF.js worker in place", async () => {
  const sentinel = "lattice-pinned-worker.mjs";
  GlobalWorkerOptions.workerSrc = sentinel;
  await import("@pdfslick/core");
  expect(GlobalWorkerOptions.workerSrc).toBe(sentinel);
});
