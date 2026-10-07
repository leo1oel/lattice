import { describe, expect, it } from "vitest";
import { comboKeys, comboText, parseKeyName } from "./key-combos";

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
