import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { usePaperListWindow } from "./paper-list-window";

type RowWindow = Pick<ReturnType<typeof usePaperListWindow>, "rowOf" | "reveal">;

/** Where a click on the row would land: its open button, else its first enabled control. */
const controlIn = (row: HTMLElement) => row.querySelector<HTMLElement>(".paper-open:not(:disabled)")
  ?? row.querySelector<HTMLElement>("button:not(:disabled)");
/** A matched paper's lines, and the "N more" after them. */
const hitsIn = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".paper-hit, .paper-hit-more")];

/**
 * The Papers list's keyboard. Tab walks every control of every paper; the
 * arrows, Home and End move between papers, across groups, landing where a
 * click on the row would. A matched paper's lines are stops of their own,
 * after its row; the up arrow from the first paper returns to the search box,
 * and `focusListRef` lets the box's down arrow come in. A paper the list has
 * not drawn yet is drawn first. Returns the rows' keydown handler.
 */
export function usePaperListKeys(
  rowKeys: readonly string[],
  rowWindow: RowWindow,
  searchInputRef: RefObject<HTMLInputElement | null>,
  focusListRef: RefObject<(() => boolean) | null>,
) {
  useEffect(() => {
    focusListRef.current = () => {
      if (!rowKeys.length) return false;
      rowWindow.reveal(0, (row) => controlIn(row)?.focus({ preventScroll: true }));
      return true;
    };
  });
  return (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".paper-row[data-paper-key]");
    const from = rowKeys.indexOf(row?.dataset.paperKey ?? "");
    if (!row || from < 0) return;
    if (Number.isFinite(step)) {
      const stops = [controlIn(row), ...hitsIn(row)];
      const at = stops.indexOf(target);
      const next = at >= 0 ? stops[at + step] : undefined;
      if (next || (from === 0 && step < 0 && at <= 0)) {
        event.preventDefault();
        (next ?? searchInputRef.current)?.focus();
        return;
      }
    }
    const to = Math.max(0, Math.min(rowKeys.length - 1, Number.isFinite(step) ? from + step : step > 0 ? rowKeys.length - 1 : 0));
    const drawn = rowWindow.rowOf(rowKeys[to]!);
    if (drawn && !controlIn(drawn)) return;
    event.preventDefault();
    const land = (into: HTMLElement) => (step === -1 ? hitsIn(into).at(-1) : undefined) ?? controlIn(into);
    rowWindow.reveal(to, (into) => land(into)?.focus({ preventScroll: true }));
  };
}
