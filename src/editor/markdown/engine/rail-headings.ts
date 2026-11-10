/** The section rail's items (R-BLK-13) for the headings the document plans. */
import type { DocumentHeadingItem } from "../document-heading-rail";
import type { DocumentHeading } from "./heading-anchors";

export const NO_HEADINGS: DocumentHeadingItem[] = [];

const railCache = new WeakMap<readonly DocumentHeading[], DocumentHeadingItem[]>();

/** The rail's items for the planned headings: the same array while the headings are the same. */
export function railHeadings(headings: readonly DocumentHeading[], size: number): DocumentHeadingItem[] {
  let items = railCache.get(headings);
  if (!items) {
    items = headings
      .filter((heading) => heading.id && !heading.generatedContents)
      .map((heading) => ({ id: heading.id, label: heading.text, level: heading.level, position: heading.pos / Math.max(1, size) }));
    railCache.set(headings, items);
  }
  return items;
}

export const sameHeadings = (a: DocumentHeadingItem[] | null, b: DocumentHeadingItem[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((item, index) => item.id === b[index]!.id && item.label === b[index]!.label && item.level === b[index]!.level));
