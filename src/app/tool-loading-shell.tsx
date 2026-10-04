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
import { createPortal } from "react-dom";
import { InfinityLoader } from "../components/ui/activity-icons";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

/** A tool panel's shell: the drawer it opens into, holding a loader. */
export function ToolLoadingShell({ className, label, onClose }: {
  /** The tool's own drawer class, so the shell docks in the tool's panel. */
  className: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <ResizableDrawer className={`${className} tool-loading-shell`} ariaLabel={label} onClose={onClose}>
      <div className="tool-loading-shell-body" role="status" aria-busy="true">
        <InfinityLoader size={16} />
      </div>
    </ResizableDrawer>
  );
}

/**
 * Settings' shell: its dialog's backdrop and card, without taking focus. Over
 * Settings itself, while it outstays it, the card alone: the dialog has its
 * own backdrop.
 */
export function SettingsLoadingShell({ label, backdrop }: { label: string; backdrop: boolean }) {
  return createPortal(
    <>
      {backdrop && <div className="modal-backdrop" onMouseDown={(event) => event.preventDefault()} />}
      <div className="modal-dialog-content tool-loading-shell-card" role="status" aria-busy="true" aria-label={label}>
        <div className="settings-modal tool-loading-shell-body">
          <InfinityLoader size={16} />
        </div>
      </div>
    </>,
    document.body,
  );
}
