import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Excalidraw 0.18.1's zh-CN catalog lacks the search panel and two canvas
// hints; patches/@excalidraw__excalidraw@0.18.1.patch adds them. Excalidraw
// reads a locale module's named exports (`t("search.title")` looks up
// `search`), so the dev and the production build each need them there.
const DIST = resolve("node_modules/@excalidraw/excalidraw/dist");

async function zhCn(build: "dev" | "prod") {
  const dir = join(DIST, build, "locales");
  const file = readdirSync(dir).find((name) => name.startsWith("zh-CN-") && name.endsWith(".js"))!;
  return import(/* @vite-ignore */ pathToFileURL(join(dir, file)).href) as Promise<{
    search?: { title?: string; placeholder?: string };
    hints: { dismissSearch?: string; createFlowchart?: string };
  }>;
}

describe("Excalidraw's zh-CN strings", () => {
  it.each(["dev", "prod"] as const)("translates Find on canvas and its hints in the %s build", async (build) => {
    const locale = await zhCn(build);
    expect(locale.search).toMatchObject({ title: "在画布上查找", placeholder: "在画布上查找文本..." });
    expect(locale.hints.dismissSearch).toBe("按 Esc 键关闭搜索");
    expect(locale.hints.createFlowchart).toBe("按住 CtrlOrCmd 和方向键创建流程图");
  });
});
