import { useEffect } from "react";
import { useLatest } from "./effect-helpers";

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
 * to `commands`, and returns the palette's runner for a command id.
 */
export function useAppCommands(commands: AppCommand[], cycleDiagnostic: (direction: 1 | -1) => void) {
  const runCommand = (id: string) => {
    const command = commands.find((item) => item.id === id);
    if (command && command.when !== false) command.run();
  };
  // Read at keypress, so a shortcut always runs the current render's closures.
  const commandsRef = useLatest(commands);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
