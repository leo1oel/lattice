import type { KeyBinding } from "@codemirror/view";

/* eslint-disable lingui/no-unlocalized-strings -- CodeMirror key names */

/**
 * Keys App.tsx binds to app-level commands. Those run from a window listener,
 * after the editor's own keymap already handled the key, so an editor binding
 * on the same keys did both: ⌘⇧K (Insert citation) also deleted the line,
 * ⌘[ / ⌘] (Back / Forward) re-indented it, ⌘G (Go to line) opened the find
 * bar, and ⌘⇧L (Insert reference) selected every match. The app's command
 * wins, so the editor keymaps drop these. Find next/previous stay on Enter,
 * Shift-Enter and F3 in the find bar.
 */
const APP_KEYS = new Set(["Mod-Shift-k", "Mod-[", "Mod-]", "Mod-g", "Mod-Shift-l"]);

/** `Shift-Mod-k`, `Mod-Shift-k` and (on macOS) `Cmd-Shift-k` name the same key. */
function normalizedKey(key: string): string {
  const parts = key.split(/-(?!$)/).map((part) => (part === "Cmd" ? "Mod" : part));
  const name = parts.pop()!;
  return [...parts.sort(), name.length === 1 ? name.toLowerCase() : name].join("-");
}

const reservedKeys = new Set([...APP_KEYS].map(normalizedKey));
const reserved = (key: string) => reservedKeys.has(normalizedKey(key));

/**
 * `bindings` without the keys App owns. A binding whose `shift` variant is
 * still free keeps that variant (⌘⇧G stays find previous).
 */
export function withoutAppShortcuts(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.flatMap((binding): KeyBinding[] => {
    const key = [binding.key, binding.mac].find((name) => name && reserved(name));
    if (!key) return [binding];
    const shifted = `Shift-${key}`;
    if (!binding.shift || reserved(shifted)) return [];
    return [{ ...binding, key: shifted, mac: undefined, run: binding.shift, shift: undefined }];
  });
}
