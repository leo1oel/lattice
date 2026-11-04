// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInputsHash, demoTutorial } from "./web-demo-content.mjs";
import overrides from "../tools/web-demo/content/overrides.json";

describe("the web demo's compiled tutorial", () => {
  it("was built from the tutorial as it is now", () => {
    const recorded = JSON.parse(readFileSync(new URL("../tools/web-demo/content/compiled/inputs.json", import.meta.url), "utf8")) as { sha256: string };
    expect(
      buildInputsHash(),
      "The tutorial, the demo's edits or its figures changed since the demo's PDF was compiled: run `node scripts/web-demo-content.mjs` and commit what it writes.",
    ).toBe(recorded.sha256);
  });

  it("applies every edit and leaves the tutorial's reproduced figures out", () => {
    const files = demoTutorial();
    for (const { file, replace } of overrides.edits) expect(files.get(file)?.toString("utf8")).toContain(replace);
    expect(files.get("figures/ATTRIBUTION.md")?.toString("utf8")).not.toContain("scholarly works");
    expect(files.get("main.tex")?.toString("utf8")).not.toContain("with permission from Google");
  });
});
