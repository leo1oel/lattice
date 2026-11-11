import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { summarizeDiagnostics } from "./compile-diagnostics";
import { buildHeadline } from "./build-result-text";

describe("buildHeadline", () => {
  afterEach(() => activateAppLocale("en"));

  it("separates the counts with the comma the interface language writes", async () => {
    const counts = { error: 1, warning: 2, info: 0 };
    await activateAppLocale("en");
    expect(buildHeadline(false, counts)).toBe("Build failed: 1 error, 2 warnings");
    await activateAppLocale("zh-CN");
    expect(buildHeadline(false, counts)).toBe("编译失败：1 个错误，2 个警告");
  });

  it("says when the build listed only its first errors", async () => {
    const located = Array.from({ length: 40 }, (_, line) => ({ level: "error", message: "Undefined control sequence.", file: "a.tex", line }));
    const counts = summarizeDiagnostics([...located, { level: "info", message: "Only the first 40…", code: "diagnostics-capped" }]);
    await activateAppLocale("en");
    expect(buildHeadline(false, counts, true)).toBe("Built with 40+ errors");
    await activateAppLocale("zh-CN");
    expect(buildHeadline(false, counts, true)).toContain("40+ 个错误");
  });
});
