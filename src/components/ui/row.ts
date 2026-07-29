import { cn } from "@/lib/utils";

export type RowDensity = "compact" | "data" | "store";

/**
 * Shared row-height contract without imposing a DOM element.
 *
 * Rows in this app may be buttons, list items, or composite divs. Returning a
 * class name keeps those semantics and event boundaries in feature code.
 */
export function rowClassName(
  density: RowDensity,
  className?: string,
) {
  return cn("ui-row", `ui-row--${density}`, className);
}
