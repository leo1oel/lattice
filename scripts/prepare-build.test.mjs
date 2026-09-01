import { describe, expect, it } from "vitest";
import { buildPreparationPlan } from "./prepare-build.mjs";

describe("Tauri package preparation profiles", () => {
  it("stages standalone Node before Chromium for debug packages", () => {
    expect(buildPreparationPlan("true")).toEqual({
      profile: "debug",
      scripts: ["prepare:runtime:dev", "prepare:chromium:debug", "build"],
    });
  });

  it("stages release resources before sharing Electron's Node", () => {
    const expected = {
      profile: "release",
      scripts: ["prepare:runtime", "prepare:chromium", "build"],
    };
    expect(buildPreparationPlan("false")).toEqual(expected);
    // Tauri CLI 2.11 currently omits the documented false value in release
    // hooks, so absence must retain the release default.
    expect(buildPreparationPlan(undefined)).toEqual(expected);
  });

  it("rejects ambiguous profile signals", () => {
    expect(() => buildPreparationPlan("1")).toThrow("Invalid TAURI_ENV_DEBUG value: 1");
  });
});
