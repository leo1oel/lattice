import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { citationHealthLabel } from "./citation-health";

describe("citationHealthLabel", () => {
  afterEach(() => activateAppLocale("en"));

  const health = { kind: "retracted", source: "retraction-watch", date: "2023-09-17", checkedAt: "2024-01-01T00:00:00Z", stale: true } as const;

  it("punctuates the warning the way the interface language writes it", async () => {
    await activateAppLocale("en");
    expect(citationHealthLabel(health)).toBe("Retracted: Retraction Watch, 2023-09-17, cached");
    expect(citationHealthLabel({ kind: "retracted", checkedAt: health.checkedAt })).toBe("Retracted");
    await activateAppLocale("zh-CN");
    expect(citationHealthLabel(health)).toBe("已撤稿：Retraction Watch，2023-09-17，缓存");
  });
});
