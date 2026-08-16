import { describe, expect, it } from "vitest";
import { msg } from "@lingui/core/macro";
import { activateAppLocale, i18n } from "./i18n";

describe("application localization", () => {
  it("loads the bundled Simplified Chinese catalog", async () => {
    await activateAppLocale("zh-CN");

    expect(i18n.locale).toBe("zh-CN");
    expect(i18n._(msg`Settings`)).toBe("设置");
    expect(i18n._(msg`Hide sidebar`)).toBe("隐藏侧边栏");
  });
});
