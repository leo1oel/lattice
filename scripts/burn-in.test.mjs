import { describe, expect, it } from "vitest";
import { overBudget, testFilesIn } from "./burn-in.mjs";

describe("testFilesIn", () => {
  it("keeps each Vitest file once, in order", () => {
    expect(testFilesIn([
      "src/b.test.tsx",
      "src/a.ts",
      "scripts/known-flakes.test.mjs",
      "src/b.test.tsx",
      "src-tauri/src/latex/build.rs",
      "src/a.test.ts.snap",
      "src/c.test.ts",
    ])).toEqual(["scripts/known-flakes.test.mjs", "src/b.test.tsx", "src/c.test.ts"]);
  });
});

describe("overBudget", () => {
  it("repeats only when every run fits the budget", () => {
    expect(overBudget(50, 5, 300)).toBe(false);
    expect(overBudget(70, 5, 300)).toBe(true);
    expect(overBudget(1_000, 5, undefined)).toBe(false);
  });
});
