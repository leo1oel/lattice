import { cn } from "@/lib/utils";
import "./chrome.css";

/**
 * A key combination drawn as keycaps, one per key ("⌘", "⇧", "J"): the
 * shortcut sheet's rows and the focus bar's hint. The combination is one
 * `kbd` around a `kbd` per key, as HTML writes a chord.
 */
export function Keycaps({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <kbd className={cn("ui-keycaps", className)}>
      {keys.map((key, index) => <kbd key={index} className="ui-keycap">{key}</kbd>)}
    </kbd>
  );
}
