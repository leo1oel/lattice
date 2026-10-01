import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPdfjsWorkers } from "./check-pdfjs-worker.mjs";

let fixture;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function distWith(workers) {
  fixture = mkdtempSync(join(tmpdir(), "pdfjs-worker-"));
  mkdirSync(join(fixture, "assets"));
  writeFileSync(join(fixture, "assets", "app-abc.js"), `const v="9.9.9";`);
  for (const [name, version] of Object.entries(workers)) {
    writeFileSync(
      join(fixture, "assets", name),
      `{docId:o,apiVersion:l}=e,f="${version}";if(l!==f)throw new Error(\`The API version "\${l}" does not match\`)`,
    );
  }
  return fixture;
}

describe("checkPdfjsWorkers", () => {
  it("accepts a single worker from the pinned release", async () => {
    expect(await checkPdfjsWorkers(distWith({ "pdf.worker.min-A1.mjs": "6.3.289" }), "6.3.289")).toEqual([]);
  });

  it("rejects a worker from another PDF.js release", async () => {
    const failures = await checkPdfjsWorkers(distWith({ "pdf.worker.min-A1.mjs": "6.2.108" }), "6.3.289");
    expect(failures).toEqual([expect.stringContaining("is PDF.js 6.2.108")]);
  });

  it("rejects a second bundled worker even when the pinned one is present", async () => {
    const failures = await checkPdfjsWorkers(
      distWith({ "pdf.worker.min-A1.mjs": "6.3.289", "pdf.worker.min-B2.mjs": "6.2.108" }),
      "6.3.289",
    );
    expect(failures[0]).toContain("found 2");
    expect(failures).toContainEqual(expect.stringContaining("pdf.worker.min-B2.mjs is PDF.js 6.2.108"));
  });

  it("rejects a bundle without a worker", async () => {
    expect(await checkPdfjsWorkers(distWith({}), "6.3.289")).toEqual([expect.stringContaining("found 0")]);
  });
});
