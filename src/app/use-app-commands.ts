import { useEffect } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { comboText, type KeyCombo } from "./key-combos";

/**
 * One app-level action, as the command palette lists it (entries with a
 * label) and as the window's shortcuts reach it (entries with a key: with ⌘
 * or Ctrl unless `mod` is false; `shift` must match). `when: false` hides an
 * entry and disables its key. The shortcut sheet lists every keyed entry
 * under its label, so a key without one is a key nobody can find.
 */
export type AppCommand = {
  id: string;
  run: () => void;
  label?: string;
  detail?: string;
  group?: string;
  /** The key as KeyboardEvent.key names it, lower-cased: "s", "?", "enter", "f8". */
  key?: string;
  shift?: boolean;
  /** False for a key pressed alone (F8), without ⌘ or Ctrl. */
  mod?: false;
  when?: boolean;
  /**
   * False keeps a command out of the palette's Recent group: one that
   * discards work (cleaning, a layout reset) should be asked for by name,
   * never sit one Enter away.
   */
  recent?: false;
  /** False lists a keyed command only in the shortcut sheet: its key is the way to it (the palette's own, ⌘1 to ⌘9). */
  palette?: false;
};

/** A keyed command's combination, for the palette, the sheet and any menu that repeats it. */
export function commandCombo(command: Pick<AppCommand, "key" | "shift" | "mod">): KeyCombo | null {
  return command.key ? { key: command.key, mod: command.mod !== false, shift: command.shift } : null;
}

/** `command`'s shortcut as written beside it, "⌘⇧J", or null without a key. */
export function commandShortcut(command: Pick<AppCommand, "key" | "shift" | "mod">): string | null {
  const combo = commandCombo(command);
  return combo ? comboText(combo) : null;
}

/** The commands the palette lists, with their shortcut ahead of any detail: "⌘⇧F · source files and papers". */
export function paletteEntries(commands: readonly AppCommand[]): AppCommand[] {
  return commands.flatMap((command) => {
    if (!command.label || command.when === false || command.palette === false) return [];
    const detail = [commandShortcut(command), command.detail].filter(Boolean).join(" · ");
    return [{ ...command, detail: detail || undefined }];
  });
}

/**
 * Binds the window's shortcuts to `commands`, and returns the palette's
 * runner for a command id. This is the only window-level shortcut listener: a
 * second one matched ⌘O whatever the Shift key, so ⌘⇧O (Go to symbol) also
 * opened the project picker.
 */
export function useAppCommands(commands: AppCommand[]) {
  const runCommand = (id: string) => {
    const command = commands.find((item) => item.id === id);
    if (command && command.when !== false) command.run();
  };
  // Read at keypress, so a shortcut always runs the current render's closures.
  const commandsRef = useLatestRef(commands);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A key an IME is composing, or one a focused surface already handled
      // (a spreadsheet cell's ⌘⇧L, a board's ⌘G), is not the app's to run.
      if (event.isComposing || event.defaultPrevented || event.altKey) return;
      const mod = event.metaKey || event.ctrlKey;
      // ⌘? is ⌘⇧/; a keyboard that reports the unshifted key still means it.
      const key = event.key === "/" && event.shiftKey ? "?" : event.key.toLocaleLowerCase();
      const command = commandsRef.current.find((item) => (
        item.key === key && Boolean(item.shift) === event.shiftKey && (item.mod !== false) === mod
      ));
      if (!command || command.when === false) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandsRef]);
  return runCommand;
}
