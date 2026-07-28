import { useEffect, useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";

export function ModalDialog(props: {
  label: string;
  onClose: () => void;
  closeDisabled?: boolean;
  backdropClassName?: string;
  children: ReactNode;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Controlled dialogs can unmount before Radix runs onCloseAutoFocus.
      // A microtask also avoids restoring focus during StrictMode's effect replay.
      queueMicrotask(() => {
        if (!mountedRef.current && returnFocusRef.current?.isConnected) {
          returnFocusRef.current.focus();
        }
      });
    };
  }, []);
  const preventWhenDisabled = (event: Event) => {
    if (props.closeDisabled) event.preventDefault();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !props.closeDisabled) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`modal-backdrop${props.backdropClassName ? ` ${props.backdropClassName}` : ""}`} />
        <Dialog.Content
          className="modal-dialog-content"
          aria-label={props.label}
          onEscapeKeyDown={preventWhenDisabled}
          onPointerDownOutside={preventWhenDisabled}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
        >
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
