import {
  useEffect,
  useRef,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { Dialog } from "radix-ui";

export function ModalDialog(props: {
  label: string;
  describedBy?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  focusDialogOnOpen?: boolean;
  backdropClassName?: string;
  windowDragTop?: {
    onMouseDown: MouseEventHandler<HTMLDivElement>;
    onDoubleClick: MouseEventHandler<HTMLDivElement>;
  };
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Controlled dialogs can unmount before Radix runs onCloseAutoFocus.
      // A microtask also avoids restoring focus during StrictMode's effect replay.
      queueMicrotask(() => {
        if (!mountedRef.current && returnFocus?.isConnected) {
          returnFocus.focus();
        }
      });
    };
  }, []);
  const preventWhenDisabled = (event: Event) => {
    if (props.closeDisabled) event.preventDefault();
  };
  const preventWindowDragDismissal = (event: Event) => {
    const originalTarget = (event as CustomEvent<{ originalEvent?: Event }>)
      .detail?.originalEvent?.target ?? event.target;
    if (
      props.closeDisabled
      || (originalTarget instanceof Element
        && (originalTarget.closest("[data-modal-window-drag]")
          // Toasts sit above the modal layer so a failure raised *by* this
          // dialog stays readable. That also makes a click on one look like an
          // outside interaction — dismissing a toast would close the dialog
          // under it and lose the work. Same guard as the vendored editor's
          // `ignoreToastInteractOutside`.
          || originalTarget.closest("[data-app-toast]")))
    ) {
      event.preventDefault();
    }
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
        {props.windowDragTop && (
          <div
            className="modal-window-drag-strip"
            data-modal-window-drag
            aria-hidden="true"
            onMouseDown={props.windowDragTop.onMouseDown}
            onDoubleClick={props.windowDragTop.onDoubleClick}
          />
        )}
        <Dialog.Content
          ref={contentRef}
          className="modal-dialog-content"
          aria-label={props.label}
          aria-describedby={props.describedBy}
          tabIndex={props.focusDialogOnOpen ? -1 : undefined}
          onOpenAutoFocus={(event) => {
            if (!props.focusDialogOnOpen) return;
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={preventWhenDisabled}
          onPointerDownOutside={preventWindowDragDismissal}
          onInteractOutside={preventWindowDragDismissal}
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
