import { useEffect } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";

/**
 * One app-level action, as the command palette lists it (entries with a
 * label) and as the global ⌘/Ctrl shortcuts reach it (entries with a key;
 * `shift` must match). `when: false` hides an entry and disables its key.
 */
export type AppCommand = {
  id: string;
  run: () => void;
  label?: string;
  detail?: string;
  group?: string;
  key?: string;
  shift?: boolean;
  when?: boolean;
};

/**
 * Binds the global ⌘/Ctrl shortcuts (and F8 for the next/previous diagnostic)
 * to `commands`, and returns the palette's runner for a command id. This is
 * the only window-level shortcut listener: a second one matched ⌘O whatever
 * the Shift key, so ⌘⇧O (Go to symbol) also opened the project picker.
 */
export function useAppCommands(commands: AppCommand[], cycleDiagnostic: (direction: 1 | -1) => void) {
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
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "F8") {
        event.preventDefault();
        cycleDiagnostic(event.shiftKey ? -1 : 1);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      const command = commandsRef.current.find((item) => item.key === key && Boolean(item.shift) === event.shiftKey);
      if (!command || command.when === false) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleDiagnostic, commandsRef]);
  return runCommand;
}
