export type PdfMarkKind = "highlight" | "note";

export type PdfMarkRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type PdfMark = {
  id: string;
  kind: PdfMarkKind;
  page: number;
  rects: PdfMarkRect[];
  color: string;
  text: string;
  note: string;
  createdAt: string;
};

export type PdfSelectionDraft = {
  text: string;
  page: number;
  rects: PdfMarkRect[];
};

const COLOR_MAP: Record<string, string> = {
  yellow: "rgba(255, 214, 10, 0.38)",
  green: "rgba(52, 199, 89, 0.34)",
  blue: "rgba(64, 156, 255, 0.34)",
  pink: "rgba(255, 99, 146, 0.34)",
};

export function pdfMarkFill(color: string): string {
  return COLOR_MAP[color] ?? COLOR_MAP.yellow;
}

/** Convert DOM selection client rects into scale-independent page coords. */
export function selectionRectsInPage(
  range: Range,
  pageElement: HTMLElement,
  scale: number,
): PdfMarkRect[] {
  if (!(scale > 0)) return [];
  const pageBounds = pageElement.getBoundingClientRect();
  const rects: PdfMarkRect[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 1 || rect.height < 1) continue;
    const left = (rect.left - pageBounds.left) / scale;
    const top = (rect.top - pageBounds.top) / scale;
    const right = (rect.right - pageBounds.left) / scale;
    const bottom = (rect.bottom - pageBounds.top) / scale;
    if (![left, top, right, bottom].every(Number.isFinite)) continue;
    rects.push({
      x1: Number(left.toFixed(3)),
      y1: Number(top.toFixed(3)),
      x2: Number(right.toFixed(3)),
      y2: Number(bottom.toFixed(3)),
    });
  }
  return mergeNearbyRects(rects);
}

function mergeNearbyRects(rects: PdfMarkRect[]): PdfMarkRect[] {
  if (rects.length <= 1) return rects;
  const sorted = [...rects].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  const merged: PdfMarkRect[] = [];
  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    if (
      last
      && Math.abs(last.y1 - rect.y1) < 2
      && Math.abs(last.y2 - rect.y2) < 2
      && rect.x1 <= last.x2 + 2
    ) {
      last.x1 = Math.min(last.x1, rect.x1);
      last.x2 = Math.max(last.x2, rect.x2);
      last.y1 = Math.min(last.y1, rect.y1);
      last.y2 = Math.max(last.y2, rect.y2);
      continue;
    }
    merged.push({ ...rect });
  }
  return merged;
}

export function pageElementForNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>("[data-pdf-page]") ?? null;
}

export function createPdfMark(draft: PdfSelectionDraft, kind: PdfMarkKind, color = "yellow", note = ""): PdfMark {
  return {
    id: crypto.randomUUID(),
    kind,
    page: draft.page,
    rects: draft.rects,
    color,
    text: draft.text,
    note,
    createdAt: new Date().toISOString(),
  };
}

export function markAnchorPoint(mark: PdfMark): { page: number; x: number; y: number } {
  const rect = mark.rects[0];
  if (!rect) return { page: mark.page, x: 0, y: 0 };
  return {
    page: mark.page,
    x: (rect.x1 + rect.x2) / 2,
    y: (rect.y1 + rect.y2) / 2,
  };
}
