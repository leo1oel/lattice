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
    ["Source editor only", ["editor-font-size"]],
    // Either wording a row switches between finds it.
    ["no name", ["author-name"]],
    ["signed from git", ["author-name"]],
    ["open a project", ["project-dictionary"]],
    ["accept", ["project-dictionary"]],
    ["harper", ["spellcheck", "project-dictionary"]],
    // A label match leads one only a description holds.
    ["build", ["page:editor", "auto-build", "aux-files", "compile-engine", "shell-escape", "interface-sounds"]],
    ["  ", []],
  ])("finds %j in English", (query, ids) => {
    expect(search(query)).toEqual(ids);
  });

  it.each([
    ["音效", ["interface-sounds"]],
    ["声音", ["interface-sounds"]],
    ["拼写", ["spellcheck"]],
    ["快捷键", ["editor-keymap"]],
    ["词典", ["project-dictionary"]],
    ["latexmkrc", ["compile-engine"]],
    ["仅源码编辑器", ["editor-font-size"]],
    ["都没有名字", ["author-name"]],
    ["评论署名为", ["author-name"]],
    ["添加术语", ["project-dictionary"]],
    ["应接受", ["project-dictionary"]],
  ])("finds %j in Chinese", async (query, ids) => {
    await act(() => activateAppLocale("zh-CN"));
    expect(search(query)).toEqual(ids);
  });

  it("finds the Agent pages by name only, and project rows only with a project", () => {
    expect(search("mcp")).toEqual(["page:mcp"]);
    expect(search("providers")).toEqual(["page:agent"]);
    expect(search("engine", false)).toEqual([]);
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
