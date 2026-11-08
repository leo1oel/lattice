import type { PdfRect } from "../editor/comments/editor-comment-data";

const percent = (value: string) => Number.parseFloat(value) / 100;

/**
 * The selection's line boxes on its first page, read from the highlight the
 * text layer draws (`.pdf-sel-rect`, in fractions of the page): after a drag
 * WebKit parks the selection in a hidden copy field, but the highlight stays.
 * Glyph boxes on one line join into one box.
 */
export function selectedLines(root: HTMLElement): { page: number; pageElement: HTMLElement; rects: PdfRect[] } | null {
  const marks = [...root.querySelectorAll<HTMLElement>(".textLayer .pdf-sel-rect")];
  const pageElement = marks[0]?.closest<HTMLElement>("[data-page-number]");
  if (!pageElement) return null;
  const page = Number.parseInt(pageElement.dataset.pageNumber ?? "", 10);
  const boxes = marks.filter((mark) => pageElement.contains(mark)).map((mark) => ({
    x: percent(mark.style.left), y: percent(mark.style.top), width: percent(mark.style.width), height: percent(mark.style.height),
  })).filter((box) => [box.x, box.y, box.width, box.height].every(Number.isFinite));
  const lines: PdfRect[] = [];
  for (const box of boxes.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((item) => Math.abs(item.y + item.height / 2 - (box.y + box.height / 2)) < Math.min(item.height, box.height) / 2);
    if (!line) {
      lines.push({ ...box });
      continue;
    }
    const right = Math.max(line.x + line.width, box.x + box.width);
    const bottom = Math.max(line.y + line.height, box.y + box.height);
    line.x = Math.min(line.x, box.x);
    line.y = Math.min(line.y, box.y);
    line.width = right - line.x;
    line.height = bottom - line.y;
  }
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return Number.isFinite(page) && lines.length
    ? { page, pageElement, rects: lines.map((line) => ({ x: round(line.x), y: round(line.y), width: round(line.width), height: round(line.height) })) }
    : null;
}
