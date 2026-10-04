import { useEffect, useLayoutEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { Dialog } from "radix-ui";

/**
 * A dialog over the app: focus stays inside, Escape closes it, and a click on
 * the backdrop dismisses it.
 *
 * Radix's modal mode is not used on purpose. On open it puts `pointer-events:
 * none` on `body`, injects a scroll-lock stylesheet and marks every sibling of
 * the portal `aria-hidden`. Each is a document-wide style invalidation, and with
 * a long document open (a 2 MB Markdown file is ~44k elements) WebKit spent
 * 1.2–1.5 s restyling before the dialog painted (Chromium ~0.3 s). The pieces
 * of modality are rebuilt locally instead: the backdrop covers the window and
 * takes outside clicks, `FocusScope` traps focus (sharing Radix's scope stack,
 * so popovers and nested dialogs pause the trap as before), Radix's dismissable
 * layer handles Escape, and `aria-modal` tells assistive technology the rest
 * of the page is inert.
 */

export function ModalDialog(props: {
  label: string;
  describedBy?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  /** Unsaved input: a click outside keeps the dialog open (Escape and the close button still close it). */
  keepOnOutsideClick?: boolean;
  focusDialogOnOpen?: boolean;
  /**
   * Where focus goes when the dialog closes, when that is not whatever held
   * focus as it opened: a dialog opened from a menu would otherwise return to
   * a menu item that closed with the menu, or to `body`.
   */
  returnFocus?: HTMLElement | null;
  /**
   * A layer above lies over the dialog (a loading shell outstaying it): it
   * is inert, and takes no focus on open, until uncovered.
   */
  covered?: boolean;
  backdropClassName?: string;
  windowDragTop?: {
    onMouseDown: MouseEventHandler<HTMLDivElement>;
    onDoubleClick: MouseEventHandler<HTMLDivElement>;
  };
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    props.returnFocus
      ?? openerOf(
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      ),
  );
  const mountedRef = useRef(false);
  const composingRef = useRef(false);
  const compositionTimerRef = useRef<number | null>(null);
  const cancelCompositionClear = () => {
    if (compositionTimerRef.current !== null) window.clearTimeout(compositionTimerRef.current);
    compositionTimerRef.current = null;
  };
  useEffect(() => () => {
    if (compositionTimerRef.current !== null) window.clearTimeout(compositionTimerRef.current);
  }, []);
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
  const preventEscapeDismissal = (event: KeyboardEvent) => {
    if (props.closeDisabled || event.isComposing || event.keyCode === 229 || composingRef.current) {
      event.preventDefault();
    }
  };
  const backdropRef = useRef<HTMLDivElement>(null);
  // Only a press on this dialog's own backdrop is an outside click. Everything
  // else outside the content sits above the backdrop: the window-drag strip,
  // toasts (a failure raised *by* this dialog must stay readable and
  // dismissable without closing the dialog and losing its work), or a dialog
  // stacked on this one, whose backdrop press belongs to that dialog alone.
  const dismissOnBackdropPress = (event: CustomEvent<{ originalEvent: PointerEvent }>) => {
    if (
      props.closeDisabled
      || props.keepOnOutsideClick
      || event.detail.originalEvent.target !== backdropRef.current
    ) {
      event.preventDefault();
    }
  };

  return (
    <Dialog.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open && !props.closeDisabled) props.onClose();
      }}
    >
      <Dialog.Portal>
        <div
          ref={backdropRef}
          className={`modal-backdrop${props.backdropClassName ? ` ${props.backdropClassName}` : ""}`}
          // A kept outside click must not blur the field the user was typing in.
          onMouseDown={(event) => event.preventDefault()}
        />
        {props.windowDragTop && (
          <div
            className="modal-window-drag-strip"
            data-modal-window-drag
            aria-hidden="true"
            onMouseDown={props.windowDragTop.onMouseDown}
            onDoubleClick={props.windowDragTop.onDoubleClick}
          />
        )}
        {/* Outermost, so this trapped scope is the one on top of the stack:
            Dialog.Content's own scope, nested inside it, is not trapped in
            non-modal mode. Focus on open and on close stays with the
            Dialog.Content handlers below. */}
        <FocusScope
          asChild
          loop
          trapped
          onMountAutoFocus={(event) => event.preventDefault()}
          onUnmountAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Content
            ref={contentRef}
            className="modal-dialog-content"
            aria-modal="true"
            aria-label={props.label}
            aria-describedby={props.describedBy}
            tabIndex={props.focusDialogOnOpen ? -1 : undefined}
            inert={props.covered}
            onOpenAutoFocus={(event) => {
              if (!props.covered && !props.focusDialogOnOpen) return;
              event.preventDefault();
              if (!props.covered) contentRef.current?.focus({ preventScroll: true });
            }}
            onCompositionStart={() => {
              cancelCompositionClear();
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              cancelCompositionClear();
              compositionTimerRef.current = window.setTimeout(() => {
                composingRef.current = false;
                compositionTimerRef.current = null;
              }, 0);
            }}
            onEscapeKeyDown={preventEscapeDismissal}
            onPointerDownOutside={dismissOnBackdropPress}
            // Focus can only leave through a layer above this one, such as a
            // dialog stacked on it, which must not close this one.
            onFocusOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
            }}
          >
            {props.children}
          </Dialog.Content>
        </FocusScope>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What had focus as each `PendingModalCard` took it. */
const pendingOpeners = new WeakMap<HTMLElement, HTMLElement | null>();

/** Where focus goes back to when a dialog opened with `focused` closes. */
function openerOf(focused: HTMLElement | null) {
  return focused && pendingOpeners.has(focused) ? pendingOpeners.get(focused) ?? null : focused;
}

/**
 * The modal layer of a dialog still on its way (a loading shell's card), so
 * keys cannot reach what it covers: focus moves into the card and stays, as
 * the card has nothing to Tab to. A `ModalDialog` that opens while the card
 * holds focus returns focus where the card found it, or to `returnFocus`; a
 * card that closes first gives it back itself.
 */
export function PendingModalCard(props: {
  label: string;
  className: string;
  /** As `ModalDialog`'s: where focus goes back to, if not where the card found it. */
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [opener] = useState(() =>
    props.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    if (cardRef.current) pendingOpeners.set(cardRef.current, opener);
  }, [opener]);
  // A card closed holding focus drops it on the page root. A dialog that
  // replaced it has taken focus by now.
  useEffect(() => () => {
    queueMicrotask(() => {
      const focused = document.activeElement;
      if ((!focused || focused === document.body) && opener?.isConnected) opener.focus();
    });
  }, [opener]);
  return (
    // Trapped like ModalDialog's scope, so focus taken from the card comes
    // back. A dialog mounting under the card stacks its scope on this one,
    // pausing it: the card holds Tab itself.
    <FocusScope asChild trapped onUnmountAutoFocus={(event) => event.preventDefault()}>
      <div
        ref={cardRef}
        className={`modal-dialog-content ${props.className}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Tab") event.preventDefault();
        }}
      >
        {props.children}
      </div>
    </FocusScope>
  );
}
