/**
 * How Lattice writes a key combination wherever it shows one: the command
 * palette, the shortcut sheet, the focus-mode bar. One parser reads every
 * keymap's notation (CodeMirror's and TipTap's `Mod-Shift-k`, Trellis's
 * `Mod+Shift+Enter`, App's commands), so a sheet built from those keymaps
 * draws what they actually bind.
 *
 * Lattice is a macOS app (its browser host runs on the same Mac), so a
 * combination is always drawn with the Mac glyphs, ⌘ first, the way the rest
 * of the interface writes them: ⌘⇧J, ⌘⌥P.
 */

/* eslint-disable lingui/no-unlocalized-strings -- key names and glyphs, not interface copy */

export type KeyCombo = {
  /** The key as KeyboardEvent.key names it: "j", "?", "Enter", "ArrowUp", "F8". */
  key: string;
  /** ⌘ (Ctrl off a Mac): what CodeMirror, TipTap and Trellis call `Mod`. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** ⌃ as a key of its own, as in CodeMirror's `Ctrl-m`. */
  ctrl?: boolean;
};

const MODIFIER_NAMES: Record<string, keyof Omit<KeyCombo, "key">> = {
  mod: "mod", cmd: "mod", meta: "mod", shift: "shift", alt: "alt", option: "alt", ctrl: "ctrl", control: "ctrl",
};

/** `Mod-Shift-k`, `Shift-Mod-k`, `Mod+Shift+Enter` and `Cmd-Alt-[` alike. */
export function parseKeyName(name: string): KeyCombo {
  const parts = name.split(/[-+](?!$)/);
  const combo: KeyCombo = { key: parts.pop() ?? "" };
  for (const part of parts) {
    const modifier = MODIFIER_NAMES[part.toLowerCase()];
    if (modifier) combo[modifier] = true;
  }
  return combo;
}

const KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  enter: "↩", escape: "Esc", backspace: "⌫", delete: "⌦", tab: "⇥", " ": "Space", space: "Space",
  pageup: "Page Up", pagedown: "Page Down", home: "Home", end: "End",
};

/** Characters that need Shift to type: their combination draws the character, not ⇧ (⌘? rather than ⌘⇧/). */
const SHIFTED_SYMBOLS = new Set([..."?{}|:\"<>+_~!@#$%^&*()"]);

/** The keys of `combo` as drawn, one keycap each: ["⌘", "⇧", "J"]. */
export function comboKeys(combo: KeyCombo): string[] {
  // A letter is drawn in capitals, as on the keycap; a named key (F8) too.
  const key = KEY_GLYPHS[combo.key.toLowerCase()] ?? (combo.key.length === 1 || /^f\d+$/i.test(combo.key) ? combo.key.toUpperCase() : combo.key);
  return [
    ...(combo.ctrl ? ["⌃"] : []),
    ...(combo.mod ? ["⌘"] : []),
    ...(combo.alt ? ["⌥"] : []),
    ...(combo.shift && !SHIFTED_SYMBOLS.has(combo.key) ? ["⇧"] : []),
    key,
  ];
}

/** `combo` written as one string, as the palette and menus show it: "⌘⇧J". */
export const comboText = (combo: KeyCombo) => comboKeys(combo).join("");
