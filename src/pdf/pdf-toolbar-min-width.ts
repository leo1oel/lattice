/**
 * The narrowest a PDF toolbar can be with every control it keeps on its row
 * and the search field usable whether or not a query is typed, measured
 * from the live toolbar. The PDF panel's minimum width follows it, so it holds in every
 * locale and at every interface zoom (all CSS px).
 *
 * A narrow panel moves its secondary controls into the overflow menu (the
 * container query in pdf-viewer.css), and the minimum is by definition
 * narrow, so the toolbar is read in that state: `data-measure-narrow` applies the same rules for the
 * duration of one synchronous read, whatever the panel's width right now.
 */

/**
 * How much of a typed query stays visible beside the match controls, as a
 * run of digits in the field's own font, so it scales with the locale's font
 * and the interface zoom like everything else measured here.
 */
const VISIBLE_QUERY_SAMPLE = "00000000";

/** The widest match counter budgeted for, in the counter's own font. */
const MATCH_COUNTER_SAMPLE = "000 / 000";

let canvas: HTMLCanvasElement | null = null;

function textWidth(text: string, style: CSSStyleDeclaration): number {
  canvas ??= document.createElement("canvas");
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a canvas context type
  const context = canvas.getContext("2d");
  if (!context) return 0;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return context.measureText(text).width;
}

const px = (value: string) => Number.parseFloat(value) || 0;
const horizontal = (style: CSSStyleDeclaration) =>
  px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth);

/** Visible children of `element` laid side by side, with its own column gap between them. */
function rowWidth(element: Element, skip?: (child: Element) => boolean): number {
  const children = [...element.children].filter((child) => !skip?.(child) && child.getClientRects().length > 0);
  const gap = px(getComputedStyle(element).columnGap);
  return children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + gap * Math.max(0, children.length - 1);
}

/**
 * Null when the toolbar is not laid out, or while a query is typed: the field
 * then holds the query and its match controls instead of the placeholder, and
 * the minimum keeps its last reading rather than growing with the query.
 */
export function measurePdfToolbarMinWidth(toolbar: HTMLElement): number | null {
  if (!toolbar.getClientRects().length) return null;
  const field = toolbar.querySelector<HTMLElement>(".pdf-find-controls [data-slot='search-field']");
  const input = field?.querySelector<HTMLInputElement>("input");
  if (!field || !input || input.value) return null;
  toolbar.setAttribute("data-measure-narrow", "");
  try {
    const toolbarStyle = getComputedStyle(toolbar);
    const columns = [...toolbar.children].filter((child) => child.getClientRects().length > 0);
    let width = horizontal(toolbarStyle) + px(toolbarStyle.columnGap) * Math.max(0, columns.length - 1);
    for (const column of columns) {
      if (column.classList.contains("pdf-find-controls")) {
        // The outline button, if any, then a field wide enough for both of its
        // states: empty, its icon and whole placeholder; with a query, some of
        // the query beside the match controls, which nothing may squeeze (they
        // are mounted, hidden, while the field is empty so they can be read).
        const fieldStyle = getComputedStyle(field);
        const inputStyle = getComputedStyle(input);
        const gap = px(fieldStyle.columnGap);
        const icon = field.querySelector(".ui-search-field-icon");
        const iconWidth = icon ? icon.getBoundingClientRect().width + gap : 0;
        const idle = iconWidth + textWidth(input.placeholder, inputStyle);
        const trailing = field.querySelector(".ui-search-field-trailing");
        // The counter is read while it says "0 / 0"; it grows with the match count.
        const counter = trailing?.querySelector(".pdf-search-position");
        const counterGrowth = counter
          ? Math.max(0, textWidth(MATCH_COUNTER_SAMPLE, getComputedStyle(counter)) + horizontal(getComputedStyle(counter)) - counter.getBoundingClientRect().width)
          : 0;
        const typing = trailing
          ? textWidth(VISIBLE_QUERY_SAMPLE, inputStyle) + gap + trailing.getBoundingClientRect().width + counterGrowth
          : 0;
        const fieldWidth = horizontal(fieldStyle) + Math.ceil(Math.max(idle, typing));
        const outline = rowWidth(column, (child) => child.contains(field));
        width += outline + (outline > 0 ? px(getComputedStyle(column).columnGap) : 0) + fieldWidth;
      } else {
        const own = rowWidth(column, (child) => child.classList.contains("pdf-overflow"));
        width += Math.max(own, px(getComputedStyle(column).minWidth)) + horizontal(getComputedStyle(column));
      }
    }
    return Math.ceil(width);
  } finally {
    toolbar.removeAttribute("data-measure-narrow");
  }
}
