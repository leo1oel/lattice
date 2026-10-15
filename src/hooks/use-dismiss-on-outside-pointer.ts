import { useEffect, type RefObject } from "react";
import { useLatestRef } from "./use-latest-ref";

/**
 * Dismiss a hand-placed popup (a comment's card, a note being written) when
 * the pointer goes down anywhere outside `popup`. The listener only
 * watches: it never prevents or stops the press, so the click still does
 * what it does where it lands (places the caret, selects on the PDF, presses
 * a button). `keep` names presses that belong to the popup though they land
 * outside it, such as the PDF pin that opened it. A null `popup` listens for
 * nothing; a ref is read at each press.
 */
export function useDismissOnOutsidePointer(
  popup: RefObject<Element | null> | Element | null,
  onDismiss: () => void,
  keep?: (target: Element) => boolean,
) {
  const latest = useLatestRef({ onDismiss, keep });
  useEffect(() => {
    if (!popup) return;
    const press = (event: PointerEvent) => {
      const element = popup instanceof Element ? popup : popup.current;
      const target = event.target;
      if (!element || !(target instanceof Element) || element.contains(target) || latest.current.keep?.(target)) return;
      latest.current.onDismiss();
    };
    // Capture, so a handler that stops the press on its way up cannot hide it.
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [latest, popup]);
}
