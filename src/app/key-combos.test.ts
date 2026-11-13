import { describe, expect, it, vi } from "vitest";
import { comboKeys, comboText, parseKeyName, shiftKeyLabel } from "./key-combos";

describe("key combinations", () => {
  it("reads every keymap's notation alike", () => {
    expect(parseKeyName("Mod-Shift-k")).toEqual({ key: "k", mod: true, shift: true });
    expect(parseKeyName("Shift-Mod-k")).toEqual({ key: "k", mod: true, shift: true });
    expect(parseKeyName("Mod+Shift+Enter")).toEqual({ key: "Enter", mod: true, shift: true });
    expect(parseKeyName("Cmd-Alt-[")).toEqual({ key: "[", mod: true, alt: true });
    expect(parseKeyName("Ctrl-m")).toEqual({ key: "m", ctrl: true });
    expect(parseKeyName("Mod-/")).toEqual({ key: "/", mod: true });
    expect(parseKeyName("F12")).toEqual({ key: "F12" });
  });

  it("draws ⌘ first, as the rest of the interface writes it, and keys as their keycaps read", () => {
    expect(comboText({ key: "j", mod: true, shift: true })).toBe("⌘⇧J");
    expect(comboText({ key: "p", mod: true, alt: true })).toBe("⌘⌥P");
    expect(comboKeys(parseKeyName("Ctrl-m"))).toEqual(["⌃", "M"]);
    expect(comboKeys(parseKeyName("Mod-Shift-ArrowUp"))).toEqual(["⌘", "⇧", "↑"]);
    expect(comboKeys(parseKeyName("Mod+Shift+Enter"))).toEqual(["⌘", "⇧", "↩"]);
    expect(comboKeys({ key: "f8", shift: true })).toEqual(["⇧", "F8"]);
    expect(comboKeys(parseKeyName("Escape"))).toEqual(["Esc"]);
  });

  it("draws a character typed with Shift as that character", () => {
    expect(comboText({ key: "?", mod: true, shift: true })).toBe("⌘?");
  });
});

it("draws Windows modifier names and keeps shortcut modifiers intact", () => {
  const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
  try {
    expect(comboText({ key: "s", mod: true })).toBe("Ctrl+S");
    expect(comboText({ key: "j", mod: true, shift: true })).toBe("Ctrl+Shift+J");
    expect(comboText({ key: "p", mod: true, alt: true })).toBe("Ctrl+Alt+P");
  } finally { userAgent.mockRestore(); }
});

it("draws a Linux window's modifiers by name too: ⌘ there would be the Super key", () => {
  const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
  try {
    expect(comboKeys({ key: "j", mod: true, shift: true })).toEqual(["Ctrl", "Shift", "J"]);
    expect(comboText({ key: "s", mod: true })).toBe("Ctrl+S");
    expect(comboText({ key: "m", ctrl: true })).toBe("Ctrl+M");
    expect(shiftKeyLabel()).toBe("Shift");
  } finally { userAgent.mockRestore(); }
  expect(shiftKeyLabel()).toBe("⇧");
});
