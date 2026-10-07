import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

/**
 * A key combination drawn as keycaps, one per key ("⌘", "⇧", "J"): one `kbd`
 * around a `kbd` per key, as HTML writes a chord. A plain function, which
 * `Keycaps` wraps for the shortcut sheet and the focus bar: an empty command
 * palette draws one per command, and a component each added a render per row
 * to every opening.
 */
export function renderKeycaps(keys: readonly string[], className?: string): ReactNode {
  return (
    <kbd className={cn("ui-keycaps", className)}>
      {keys.map((key, index) => <kbd key={index} className="ui-keycap">{key}</kbd>)}
    </kbd>
  );
}
