/*
 * The list's widths reach its CSS as attributes, not container queries.
 * WebKit restyles everything inside a query container whose width changes,
 * and with the list and each row a container, every frame of a panel divider
 * drag beside 600 papers restyled every row drawn: 8 ms of an 18 ms frame.
 * An attribute changes only when its width crosses a step (app-shell.css).
 */
/** From this width the list is a table (`data-table`). */
const TABLE_MIN_WIDTH = 680;
/** The list's widths below which its error state stacks (`data-below`). */
const LIST_STEPS = [240];
/** The list's height below which its empty state lets its drawing go (`data-short`). */
const EMPTY_ART_MIN_HEIGHT = 190;
/** The rows' content widths below which their lines give way (`data-row-below` on `.paper-rows`). */
const ROW_STEPS = [300, 260, 200];

function setSteps(element: HTMLElement, name: string, width: number, steps: readonly number[]) {
  const below = steps.filter((step) => width < step).join(" ");
  if ((element.getAttribute(name) ?? "") === below) return;
  if (below) element.setAttribute(name, below);
  else element.removeAttribute(name);
}

const contentWidth = (entry: ResizeObserverEntry) => entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;

/** The ref of a `.paper-list` scroll area: marks the steps its own width has passed, and whether it is short. */
export function observeListSteps(list: HTMLDivElement | null) {
  if (!list || typeof ResizeObserver === "undefined") return undefined;
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const width = contentWidth(entry);
    list.toggleAttribute("data-table", width >= TABLE_MIN_WIDTH);
    setSteps(list, "data-below", width, LIST_STEPS);
    list.toggleAttribute("data-short", (entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height) < EMPTY_ART_MIN_HEIGHT);
  });
  observer.observe(list);
  return () => observer.disconnect();
}

/** The ref of `.paper-rows`: marks the steps its rows' content box has passed. */
export function observeRowSteps(rows: HTMLDivElement | null) {
  if (!rows || typeof ResizeObserver === "undefined") return undefined;
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    // Each row spans the rows' box; its content box is that less its own inline padding.
    const padding = Number.parseFloat(getComputedStyle(rows).getPropertyValue("--paper-row-padding-inline")) || 0;
    setSteps(rows, "data-row-below", contentWidth(entry) - 2 * padding, ROW_STEPS);
  });
  observer.observe(rows);
  return () => observer.disconnect();
}
