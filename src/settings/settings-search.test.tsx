import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSearch } from "./settings-search";
import type { SettingsSearchEntry } from "./settings-search-index";

const entries: SettingsSearchEntry[] = [
  { tab: "appearance", place: "外观", id: "interface-sounds", label: "界面音效" },
  { tab: "appearance", place: "外观", id: "interface-language", label: "界面语言" },
];

function renderSearch(query: string) {
  const onOpen = vi.fn();
  render(<SettingsSearch entries={entries} query={query} onQueryChange={vi.fn()} current={null} onOpen={onOpen} />);
  return { onOpen, input: screen.getByRole("searchbox", { name: "Search settings" }) };
}

describe("SettingsSearch", () => {
  afterEach(cleanup);

  it("leaves Enter and arrows that drive a Chinese IME to it, then opens the result after", async () => {
    vi.useFakeTimers();
    try {
      const { onOpen, input } = renderSearch("音");
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229, isComposing: true });
      fireEvent.compositionEnd(input);
      // WebKit sends compositionend just before the Enter that accepts the candidate.
      fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: false });
      expect(onOpen).not.toHaveBeenCalled();

      act(() => vi.runAllTimers());
      fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
      expect(onOpen).toHaveBeenCalledWith(entries[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the result the arrows choose", () => {
    const { onOpen, input } = renderSearch("界面");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(entries[1]);
  });
});
