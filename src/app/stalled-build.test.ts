import { describe, expect, it } from "vitest";
import { automaticBuildWouldStall, forgetBuildStall, noteBuildOutcome } from "./stalled-build";

describe("automatic builds after a stall", () => {
  it("wait for an edit, and resume after any other result", () => {
    noteBuildOutcome([{ code: "build-stalled" }], "text");
    expect(automaticBuildWouldStall("text")).toBe(true);
    expect(automaticBuildWouldStall("edited")).toBe(false);
    noteBuildOutcome([{ code: "other" }], "text");
    expect(automaticBuildWouldStall("text")).toBe(false);
  });

  it("resume when any project file changes, the open text staying the same", () => {
    noteBuildOutcome([{ code: "build-stalled" }], "text");
    forgetBuildStall();
    expect(automaticBuildWouldStall("text")).toBe(false);
  });
});
