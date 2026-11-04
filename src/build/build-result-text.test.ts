import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
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
});
