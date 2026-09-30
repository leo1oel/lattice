import { describe, expect, it } from "vitest";
import { spaceMixedScript } from "./trellis-titles";

describe("spaceMixedScript", () => {
  it("spaces Han characters from Latin words and never between Han characters", () => {
    expect(spaceMixedScript("显示PDF面板")).toBe("显示 PDF 面板");
    expect(spaceMixedScript("关闭 项目")).toBe("关闭项目");
    expect(spaceMixedScript("关闭 main.tex")).toBe("关闭 main.tex");
    expect(spaceMixedScript("Close Project")).toBe("Close Project");
  });
});
