import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { bylineOf } from "./paper-add";

describe("bylineOf", () => {
  afterEach(() => activateAppLocale("en"));

  it("joins the parts it has with the comma the interface language writes", async () => {
    await activateAppLocale("en");
    expect(bylineOf(["Hewitt and Liang", " 2019 ", null, "EMNLP"])).toBe("Hewitt and Liang, 2019, EMNLP");
    await activateAppLocale("zh-CN");
    expect(bylineOf(["Hewitt 和 Liang", "2019", undefined, "正在查找…"])).toBe("Hewitt 和 Liang，2019，正在查找…");
  });
});
