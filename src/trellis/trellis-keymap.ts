import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/* eslint-disable lingui/no-unlocalized-strings -- Trellis command ids and key names */

/**
 * How Lattice changes Trellis's own shortcuts (its DEFAULT_KEYMAP); the
 * workspace passes this as its keymap and the shortcut sheet lists the
 * result. The whole-workspace overview (⌘⌥↑) is not offered. Previous and
 * next tab move to ⌘⇧[ and ⌘⇧], the Mac's tab keys: Trellis's ⌘⌥[ and ⌘⌥]
 * are the source editor's fold and unfold, so in the editor they folded
 * where the caret could fold and switched tabs everywhere else.
 */
export const TRELLIS_KEYMAP = {
  "navigation.overview": null,
  "tab.previous": "Mod+Shift+[",
  "tab.next": "Mod+Shift+]",
};

/** Trellis's commands as the shortcut sheet lists them, a row per pair. */
export const TRELLIS_SHORTCUTS: Array<{ label: MessageDescriptor; commands: string[] }> = [
  { label: msg`Previous or next tab`, commands: ["tab.previous", "tab.next"] },
  { label: msg`Close the tab`, commands: ["view.close"] },
  { label: msg`Previous or next panel`, commands: ["panel.previous", "panel.next"] },
  { label: msg`Maximize or restore the focused panel`, commands: ["frame.toggle"] },
  { label: msg`Previous or next zoomed view`, commands: ["navigation.back", "navigation.forward"] },
];

/**
 * Trellis's own maximize-or-restore key (DEFAULT_KEYMAP's frame.toggle, which
 * Lattice keeps), for the palette to show without loading Trellis.
 */
export const FRAME_TOGGLE_KEY = { key: "Enter", mod: true, shift: true } as const;

/** Focus mode's key, ⌘⇧D (distraction-free): App binds it, and the Panels menu and focus bar show it. */
export const FOCUS_MODE_KEY = { key: "d", shift: true } as const;

/** The key that also leaves focus mode, when nothing else on screen takes it (see useFocusModeEscape). */
export const FOCUS_MODE_EXIT_KEY = "Escape";
