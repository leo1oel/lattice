/**
 * Where a terminal's screen stands in the Terminal panel (terminal-panel.tsx),
 * and when its grid takes the slot's size.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { XtermScreen } from "./terminal-screen";

/** How long the slot's size must hold before the grid (and the shell) take it. */
export const SETTLE_MS = 120;

type SlotScreen = Pick<XtermScreen, "element" | "attach" | "fit" | "focus" | "setShown">;

/**
 * The slot a session's screen stands in: shown only for the tab in front.
 *
 * The grid takes a size only once the slot has held it for `SETTLE_MS`, and
 * not at all while a panel is dragged (`moving`). Each size the grid takes
 * reflows its lines and makes the shell redraw its prompt where it thinks
 * the prompt is. Trellis shrinks a dragged panel to a strip a row high, which
 * pushed a multi-line prompt's first line into the scrollback, out of the
 * redraw's reach, so the prompt came back twice; and a dropped panel grows
 * into place over a dozen frames, each one more redraw racing a reflow. So a
 * move is one resize: the panel's size before, then its size after.
 */
export function ScreenSlot({ screen, shown, focused, moving }: { screen: SlotScreen; shown: boolean; focused: boolean; moving: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    screen.attach(slot);
    return () => {
      if (screen.element.parentElement === slot) slot.removeChild(screen.element);
    };
  }, [screen]);
  useLayoutEffect(() => {
    screen.setShown(shown);
    const slot = ref.current;
    if (!shown || moving || !slot) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Called once when observing starts, then on every change of the slot's
    // size (a drop, the divider dragged, the window resized).
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => screen.fit(), SETTLE_MS);
    });
    observer.observe(slot);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [screen, shown, moving]);
  useEffect(() => {
    if (shown && focused) screen.focus();
  }, [screen, shown, focused]);
  return <div ref={ref} className="terminal-slot" hidden={!shown} />;
}
