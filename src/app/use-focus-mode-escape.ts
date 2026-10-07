import { useEffect } from "react";
import type { TrellisController } from "../trellis/trellis-controller";
import { FOCUS_MODE_EXIT_KEY } from "../trellis/trellis-keymap";

/**
 * What Escape closes before it can mean "leave focus mode": a dialog, a menu
 * or popover, a list of suggestions. Most of them also mark the key handled,
 * but one that closes without saying so must not take focus mode with it.
 */
const ESCAPE_TAKERS = [
  "[role=dialog]", "[role=alertdialog]", "[role=menu]", "[role=listbox]", "[data-radix-popper-content-wrapper]",
  ".cm-tooltip-autocomplete",
].join(", ");

/**
 * While mounted (focus mode's bar is), Escape leaves focus mode, but only as the key's last
 * meaning: not one a focused surface handled (the editor collapsing a
 * selection, closing its find bar or completions), not while anything that
 * Escape closes was open as the key went down, never with modifiers or an
 * IME composing, and never in Vim, where Escape is the writer's own.
 */
export function useFocusModeEscape(trellis: TrellisController) {
  useEffect(() => {
    let takenAtStart = false;
    // Capture runs before any handler can close what was open.
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === FOCUS_MODE_EXIT_KEY) takenAtStart = document.querySelector(ESCAPE_TAKERS) !== null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== FOCUS_MODE_EXIT_KEY || takenAtStart || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest(".cm-vimMode")) return;
      event.preventDefault();
      trellis.setFocus(false);
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [trellis]);
}
