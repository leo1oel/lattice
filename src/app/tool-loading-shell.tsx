/**
 * The loading shell of a lazily loaded tool: Settings, Project history and
 * Editor comments. Each opens as a transition, so React keeps the current
 * screen until the tool's chunk is in (docs/performance.md); once that has
 * taken 150 ms (`useLoadingShell`), a shell of the tool's own size holds its
 * place, and stays at least 300 ms, over the tool if it arrives sooner, so it
 * cannot flash.
 *
 * The shell is an ordinary element beside the tool's `Suspense` boundary, not
 * its fallback. A committed fallback arms React's Suspense reveal throttle,
 * which would then hold the tool back until 300 ms after it, however soon the
 * chunk arrived.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PendingModalCard } from "../components/ui/modal-dialog";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

/** A tool panel's shell: the drawer it opens into, holding a loader. */
export function ToolLoadingShell({ className, label, message, onClose }: {
  /** The tool's own drawer class, so the shell docks in the tool's panel. */
  className: string;
  label: string;
  /** What the loader says to the eye, for assistive technology: "Loading project history…". */
  message: string;
  onClose: () => void;
}) {
  return (
    <ResizableDrawer className={`${className} tool-loading-shell`} ariaLabel={label} onClose={onClose}>
      <div className="tool-loading-shell-body" aria-busy="true">
        <InfinityLoader size={16} />
      </div>
      <LoadingAnnouncement message={message} />
    </ResizableDrawer>
  );
}

/**
 * Settings' shell: its dialog's backdrop and card. Until Settings is there
 * the card is the modal layer Settings will be (`PendingModalCard`), holding
 * the keyboard. Escape closes it as it would Settings: `onClose` withdraws
 * the pending open, so Settings does not appear when its chunk arrives.
 *
 * Over Settings itself, while it outstays it, the card alone: the dialog has
 * its own backdrop, and is inert until the card is gone (`ModalDialog`'s
 * `covered`).
 */
export function SettingsLoadingShell({ label, message, backdrop, returnFocus, onClose }: {
  label: string;
  message: string;
  backdrop: boolean;
  /** Settings' own `returnFocus`, for the card closed before Settings is there. */
  returnFocus?: HTMLElement | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!backdrop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [backdrop, onClose]);
  return createPortal(
    <>
      {backdrop && <div className="modal-backdrop" onMouseDown={(event) => event.preventDefault()} />}
      <PendingModalCard label={label} className="tool-loading-shell-card" returnFocus={returnFocus}>
        <div className="settings-modal tool-loading-shell-body" aria-busy="true">
          <InfinityLoader size={16} />
        </div>
        <LoadingAnnouncement message={message} />
      </PendingModalCard>
    </>,
    document.body,
  );
}

/**
 * The shell's message, in a polite live region outside its busy part.
 * The region is in the page a frame before its text: one that arrives
 * already holding it is not reliably announced.
 */
function LoadingAnnouncement({ message }: { message: string }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSaid(message));
    return () => window.cancelAnimationFrame(frame);
  }, [message]);
  return <p className="tool-loading-shell-message" role="status" aria-live="polite">{said}</p>;
}
