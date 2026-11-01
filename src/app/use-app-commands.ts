import { useEffect } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { comboKeys, type KeyCombo } from "./key-combos";
import type { PaletteSection } from "./palette-sections";

/**
 * One app-level action, as the command palette lists it (entries with a
 * label) and as the window's shortcuts reach it (entries with a key: with ⌘
 * or Ctrl unless `mod` is false; `shift` and `alt` must match). `when: false` hides an
 * entry and disables its key. The shortcut sheet lists every keyed entry
 * under its label, so a key without one is a key nobody can find.
 */
export type AppCommand = {
  id: string;
  run: () => void;
  label?: string;
  /** A quiet note after the label; never the shortcut, which the palette draws from `key` or `shortcut`. */
  detail?: string;
  group?: PaletteSection;
  /** Words the palette should find it by that the label does not say. */
  keywords?: string;
  /** The key as KeyboardEvent.key names it, lower-cased: "s", "?", "enter", "f8". */
  key?: string;
  shift?: boolean;
  /** ⌥ (Option) is held too. */
  alt?: boolean;
  /** False for a key pressed alone (F8), without ⌘ or Ctrl. */
  mod?: false;
  /** ⌃ itself, never ⌘: the terminal's ⌃`, where ⌘` would cycle the windows. */
  ctrl?: true;
  /**
   * The keys shown for a command something other than this table binds:
   * Trellis's ⌘⇧↩, ⌘1 to ⌘9 by position, the editor's ⌘⌥P, ⌘S through
   * Save. A command with a `key` shows that instead, so its hint cannot
   * drift from the binding; the shortcut sheet lists only `key`s.
   */
  shortcut?: KeyCombo;
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
export function commandCombo(command: Pick<AppCommand, "key" | "shift" | "alt" | "mod" | "ctrl">): KeyCombo | null {
  if (!command.key) return null;
  return { key: command.key, mod: command.mod !== false && !command.ctrl, ctrl: command.ctrl, shift: command.shift, alt: command.alt };
}

/** A command's keys as one string ("⌘P"), for a hint beside another control that runs it. */
export function commandShortcutText(commands: readonly AppCommand[], id: string): string | null {
  const command = commands.find((entry) => entry.id === id);
  const keys = command && commandKeys(command);
  return keys ? keys.join("") : null;
}

/** The keycaps the palette draws beside `command`: its key's, else the `shortcut` bound elsewhere. */
export function commandKeys(command: Pick<AppCommand, "key" | "shift" | "alt" | "mod" | "ctrl" | "shortcut">): string[] | null {
  const combo = commandCombo(command) ?? command.shortcut;
  return combo ? comboKeys(combo) : null;
}

/** The commands the palette lists: labelled, runnable here, and not reached only by their key. */
export function paletteEntries(commands: readonly AppCommand[]): AppCommand[] {
  return commands.filter((command) => command.label && command.when !== false && command.palette !== false);
}

/** What a keydown says, for matching it to a combination: a real event, or one a Synara frame forwarded. */
export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * Whether `press` is `combo`, the way the command table means its keys.
 * ⌘? is ⌘⇧/; a keyboard that reports the unshifted key still means it.
 * ⌥ types another character on a Mac (⌥1 is ¡), so with ⌥ held a digit or
 * letter is read from the key's position instead. Synara's
 * `latticeHostShortcuts.ts` matches forwarded keys the same way.
 */
export function pressMatches(combo: KeyCombo, press: KeyPress): boolean {
  const key = press.altKey && /^(Digit\d|Key[A-Z])$/.test(press.code)
    ? press.code.slice(-1).toLocaleLowerCase()
    : press.key === "/" && press.shiftKey ? "?" : press.key.toLocaleLowerCase();
  return combo.key === key && Boolean(combo.shift) === press.shiftKey && Boolean(combo.alt) === press.altKey
    && (combo.ctrl ? press.ctrlKey && !press.metaKey : Boolean(combo.mod) === (press.metaKey || press.ctrlKey));
}

/** The combinations of the commands that can run now, each modifier spelled out. */
function liveCombos(commands: readonly AppCommand[]): Required<KeyCombo>[] {
  return commands.flatMap((command) => {
    const combo = command.when === false ? null : commandCombo(command);
    return combo ? [{ key: combo.key, mod: Boolean(combo.mod), ctrl: Boolean(combo.ctrl), shift: Boolean(combo.shift), alt: Boolean(combo.alt) }] : [];
  });
}

/**
 * The keys the window's commands can run now, as useAppCommands last bound
 * them: what every Synara frame leaves to Lattice. The frames' bridge
 * (synara-host-shortcuts.ts) follows it from where the frames live.
 */
export const liveShortcuts = (() => {
  let combos: Required<KeyCombo>[] = [];
  let serialized = "[]";
  const listeners = new Set<() => void>();
  return {
    get: () => combos,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: Required<KeyCombo>[]) {
      const key = JSON.stringify(next);
      if (key === serialized) return;
      combos = next;
      serialized = key;
      for (const listener of [...listeners]) listener();
    },
  };
})();

/**
 * Binds the window's shortcuts to `commands`, and returns the palette's
 * runner for a command id. This is the only window-level shortcut listener: a
 * second one matched ⌘O whatever the Shift key, so ⌘⇧O (Go to symbol) also
 * opened the project picker. A key pressed in a Synara frame arrives here too,
 * re-dispatched on its iframe (synara-host-shortcuts.ts).
 */
export function useAppCommands(commands: AppCommand[]) {
  const runCommand = (id: string) => {
    const command = commands.find((item) => item.id === id);
    if (command && command.when !== false) command.run();
  };
  // Read at keypress, so a shortcut always runs the current render's closures.
  const commandsRef = useLatestRef(commands);
  // What can run changes with the render (⌘G only with a text editor in front).
  useEffect(() => liveShortcuts.publish(liveCombos(commands)));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A key an IME is composing, or one a focused surface already handled
      // (a spreadsheet cell's ⌘⇧L, a board's ⌘G), is not the app's to run.
      if (event.isComposing || event.defaultPrevented) return;
      // A key may belong to one command here and another there (⌘1 picks a
      // workspace in a project and a recent project on the welcome screen):
      // the one that can run now takes it.
      const command = commandsRef.current.find((item) => {
        const combo = item.when === false ? null : commandCombo(item);
        return combo !== null && pressMatches(combo, event);
      });
      if (!command) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandsRef]);
  return runCommand;
}
