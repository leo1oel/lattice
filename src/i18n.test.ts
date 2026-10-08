import { describe, expect, it } from "vitest";
import { msg, t } from "@lingui/core/macro";
import { activateAppLocale, i18n } from "./i18n";

describe("application localization", () => {
  it("loads the bundled Simplified Chinese catalog", async () => {
    await activateAppLocale("zh-CN");

    expect(i18n.locale).toBe("zh-CN");
    expect(i18n._(msg`Settings`)).toBe("设置");
    expect(i18n._(msg`Panels`)).toBe("面板");
    expect(i18n._(msg`Providers`)).toBe("模型");
    expect(i18n._(msg`Skills`)).toBe("技能");
    expect(i18n._(msg`Starting Agent`)).toBe("正在启动 AI 助手");
    expect(i18n._(msg`Editor comments`)).toBe("批注");
    expect(i18n._(msg`Include resolved`)).toBe("含已解决");
  });

  it("activates the instance that standalone core macros resolve through", async () => {
    await activateAppLocale("zh-CN");

    expect(t`Settings`).toBe("设置");
  });
});
