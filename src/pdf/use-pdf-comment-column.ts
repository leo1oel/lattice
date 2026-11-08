import { useLayoutEffect, useReducer, type RefObject } from "react";

/**
 * The narrowest PDF area that keeps the column docked beside the pages: the
 * column's 280px and room for a page still worth reading. Narrower, the
 * column folds away and opens over the pages' right side when asked for.
 */
const DOCK_MIN_WIDTH = 640;

type ColumnState = { area: HTMLElement | null; narrow: boolean; chosen: boolean | null };
type ColumnAction = { area: HTMLElement | null; narrow: boolean } | { chosen: boolean };

const reduceColumn = (state: ColumnState, action: ColumnAction): ColumnState => {
  if ("chosen" in action) return state.chosen === action.chosen ? state : { ...state, chosen: action.chosen };
  return state.area === action.area && state.narrow === action.narrow ? state : { ...state, ...action };
};

/**
 * Whether the PDF shows its comments in a column beside the pages: docked
 * there by default while the PDF area is wide enough, folded away when
 * narrow, and either way as the writer last chose while this PDF is open.
 * A docked column takes its width from the pages (`data-comment-column` on
 * the scroll area, pdf-comment-column.css), which a fitted zoom follows.
 */
export function usePdfCommentColumn(previewRef: RefObject<HTMLDivElement | null>, hasComments: boolean, generation: number) {
  const [state, dispatch] = useReducer(reduceColumn, { area: null, narrow: false, chosen: null });
  useLayoutEffect(() => {
    // The viewer's own scroll area, which the column stands in beside the pages.
    const area = previewRef.current?.querySelector<HTMLElement>(":scope > .pdf-scroll-area") ?? null;
    if (!area) return;
    const measure = () => dispatch({ area, narrow: area.clientWidth < DOCK_MIN_WIDTH });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [generation, previewRef]);
  const open = Boolean(state.area && hasComments && (state.chosen ?? !state.narrow));
  const docked = open && !state.narrow;
  const { area } = state;
  useLayoutEffect(() => {
    if (!area || !docked) return;
    area.setAttribute("data-comment-column", "");
    return () => area.removeAttribute("data-comment-column");
  }, [area, docked]);
  return { area, open, docked, setOpen: (chosen: boolean) => dispatch({ chosen }) };
}
