import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { PopIn } from "../components/ui/motion";

export type TexInstallDialogProgress = {
  /** Accessible name of the progress bar. */
  label: string;
  percent: number;
  stage: string;
  detail: string;
};

/** Shared layout of the LaTeX install dialogs: copy, native install progress, error, and actions. */
export function TexInstallDialog({ label, title, description, closeDisabled, onClose, progress, error, children }: {
  label: string;
  title: string;
  description: ReactNode;
  closeDisabled: boolean;
  onClose: () => void;
  progress: TexInstallDialogProgress | null;
  error: string | null;
  children?: ReactNode;
}) {
  return (
    <ModalDialog label={label} onClose={onClose} closeDisabled={closeDisabled} backdropClassName="tex-setup-backdrop">
      <PopIn className={["modal", "tex-setup-modal"].join(" ")}>
        <div className="modal-icon"><Wrench size={18} /></div>
        <h2>{title}</h2>
        <p>{description}</p>
        {progress && (
          <div className="tex-setup-progress-block" aria-live="polite">
            <div
              className="tex-setup-progress"
              role="progressbar"
              aria-label={progress.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
            >
              <div className="tex-setup-progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="tex-setup-progress-copy">
              <span>{progress.stage} {progress.percent}%</span>
              <small>{progress.detail}</small>
            </div>
          </div>
        )}
        {error && <InlineMessage level="error" className="tex-setup-status">{error}</InlineMessage>}
        {children}
      </PopIn>
    </ModalDialog>
  );
}
