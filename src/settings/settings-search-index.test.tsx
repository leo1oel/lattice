import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { searchSettings, useSettingsSearchIndex } from "./settings-search-index";

afterEach(async () => {
  await activateAppLocale("en");
});

function search(query: string, hasProject = true) {
  const { result } = renderHook(() => useSettingsSearchIndex(hasProject));
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
  ])("finds %j in Chinese", async (query, ids) => {
    await act(() => activateAppLocale("zh-CN"));
    expect(search(query)).toEqual(ids);
  });

  it("finds the Agent pages by name only, and project rows only with a project", () => {
    expect(search("mcp")).toEqual(["page:mcp"]);
    expect(search("providers")).toEqual(["page:agent"]);
    expect(search("engine", false)).toEqual([]);
  });
});
