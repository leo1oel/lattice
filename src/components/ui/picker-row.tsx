import type { ReactNode } from "react";
import { renderKeycaps } from "./render-keycaps";
import type { SearchPickerItem } from "./search-picker-dialog";

/**
 * One row: its icon, label and detail, and the shortcut that runs it without
 * the picker. A plain function rather than a component, as
 * `renderKeycaps` is: an empty palette lists every command, and a
 * component per row added a render per row to each opening.
 */
export function searchPickerRow(item: SearchPickerItem): ReactNode {
  const text = <>
    <span className="picker-label">{item.label}</span>
    {item.detail && <em className="picker-detail">{item.detail}</em>}
  </>;
  if (!item.icon && !item.keys) return text;
  return <>
    {item.icon && <span className="picker-icon" aria-hidden="true">{item.icon}</span>}
    <span className="picker-text">{text}</span>
    {item.keys && renderKeycaps(item.keys, "picker-shortcut")}
  </>;
}
