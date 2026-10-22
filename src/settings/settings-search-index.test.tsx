import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { searchSettings, useSettingsSearchIndex } from "./settings-search-index";

afterEach(async () => {
  await activateAppLocale("en");
});

function search(query: string, hasProject = true, knownAuthorName: string | null = null) {
  const { result } = renderHook(() => useSettingsSearchIndex(hasProject, knownAuthorName));
  return searchSettings(result.current, query).map((entry) => entry.id ?? `page:${entry.tab}`);
}

describe("settings search", () => {
  it.each([
    ["sound", ["interface-sounds"]],
    ["spell", ["spellcheck"]],
    ["keymap", ["editor-keymap"]],
    ["emacs", ["editor-keymap"]],
    ["xelatex", ["compile-engine"]],
    ["api key", ["literature-openalex", "literature-semanticscholar", "literature-firecrawl"]],
    ["latexmkrc", ["compile-engine"]],
    // A cut description's words live on in the row's terms.
    ["source editor", ["editor-font-size"]],
    ["desktop", ["translucency"]],
    [".aux", ["aux-files"]],
    ["crossref", ["literature-email"]],
    // A row's earlier label still finds it.
    ["external commands", ["shell-escape"]],
    ["signed from git", ["author-name"]],
    ["open a project", ["project-dictionary"]],
    ["harper", ["spellcheck", "project-dictionary"]],
    // Label matches lead the rows only their terms match.
    ["build", ["page:editor", "auto-build", "aux-files", "compile-engine", "shell-escape"]],
    // Then the rows only a description holds.
    ["reduce transparency", ["translucency"]],
    // An option name finds its row.
    ["live sync", ["overleaf-sync-mode"]],
    ["ask before deleting", ["overleaf-remote-delete"]],
    ["history keeps a copy", ["overleaf-remote-delete"]],
    ["  ", []],
  ])("finds %j in English", (query, ids) => {
    expect(search(query)).toEqual(ids);
  });

  it.each([
    ["提示音", ["interface-sounds"]],
    ["声音", ["interface-sounds"]],
    ["拼写", ["spellcheck"]],
    ["快捷键", ["editor-keymap"]],
    ["词库", ["project-dictionary"]],
    ["latexmkrc", ["compile-engine"]],
    ["外部程序", ["shell-escape"]],
    ["评论署名", ["author-name"]],
    ["可添加", ["project-dictionary"]],
  ])("finds %j in Chinese", async (query, ids) => {
    await act(() => activateAppLocale("zh-CN"));
    expect(search(query)).toEqual(ids);
  });

  it("finds the Agent pages by name only, and project rows only with a project", () => {
    expect(search("mcp")).toEqual(["page:mcp"]);
    expect(search("providers")).toEqual(["page:agent"]);
    expect(search("engine", false)).toEqual([]);
  });

  it("finds Live preview only in a LuaLaTeX project, which is offered it", async () => {
    const find = (query: string, livePreview: boolean) => {
      const { result } = renderHook(() => useSettingsSearchIndex(true, null, livePreview));
      return searchSettings(result.current, query).map((entry) => entry.id ?? `page:${entry.tab}`);
    };
    expect(find("rtex", false)).toEqual([]);
    expect(find("rtex", true)).toEqual(["live-preview"]);
    expect(find("live preview", true)).toEqual(["live-preview"]);
    await act(() => activateAppLocale("zh-CN"));
    expect(find("实时预览", true)).toEqual(["live-preview"]);
  });

  it("finds Your name by the name its comments are signed with", () => {
    expect(search("lovelace", true, "Ada Lovelace")).toEqual(["author-name"]);
  });

  it("finds Acknowledgements in every build by what it credits", () => {
    expect(search("open source libraries")).toEqual(["page:acknowledgements"]);
    expect(search("third-party notices")).toEqual(["page:acknowledgements"]);
  });

  it("finds Acknowledgements by the font it credits and its license, only in a build that embeds them", async () => {
    // The suite runs as a build without them.
    expect(search("timeless")).toEqual([]);
    vi.resetModules();
    vi.doMock("virtual:lattice-private-fonts-license", () => ({ fontLicenseUrl: "/assets/LICENSE-stand-in.pdf" }));
    try {
      const withFonts = await import("./settings-search-index");
      const i18n = await import("../i18n");
      const find = (query: string) => {
        const { result } = renderHook(() => withFonts.useSettingsSearchIndex(true, null));
        return withFonts.searchSettings(result.current, query).map((entry) => entry.id ?? `page:${entry.tab}`);
      };
      for (const locale of ["en", "zh-CN"] as const) {
        await act(() => i18n.activateAppLocale(locale));
        expect(find("Timeless"), locale).toEqual(["page:acknowledgements"]);
        expect(find("free font license"), locale).toEqual(["page:acknowledgements"]);
      }
      await act(() => i18n.activateAppLocale("en"));
    } finally {
      vi.doUnmock("virtual:lattice-private-fonts-license");
    }
  });
});
