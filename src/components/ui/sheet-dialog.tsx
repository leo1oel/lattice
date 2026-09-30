import type { ReactNode } from "react";
import { ModalDialog } from "./modal-dialog";

/**
 * A form or tool that used to slide in from the right edge, centered over the
 * app like the Open from Overleaf picker: focus stays inside, Escape closes it,
 * and a click outside dismisses it unless it holds unsaved input (`dirty`).
 * Its first child is usually a `PanelHeader` with the `drawer-header` class,
 * which becomes the dialog's title row.
 */
export function SheetDialog(props: {
  label: string;
  className?: string;
  dirty?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalDialog label={props.label} keepOnOutsideClick={props.dirty} onClose={props.onClose}>
      <div className={`modal sheet-dialog native-hover-scrollbar ${props.className ?? ""}`.trim()}>
        {props.children}
      </div>
    </ModalDialog>
  );
}
