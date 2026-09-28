import type { ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Wrench } from "lucide-react";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { PopIn } from "../components/ui/motion";
import type { TexDependencyInstallProgress, TexInstallProgress } from "./tex-setup";

type TexInstallStage = TexInstallProgress["stage"] | TexDependencyInstallProgress["stage"];

/** What each native install stage is doing, and what the writer can expect from it. */
function useStageCopy(): Record<TexInstallStage, readonly [stage: string, detail: string]> {
  const { t } = useLingui();
  return {
    downloading: [t`Downloading BasicTeX…`, t`Download time depends on your connection`],
    authorizing: [t`Waiting for administrator approval…`, t`Approve the macOS prompt to continue`],
    "installing-base": [t`Installing BasicTeX…`, t`This step may take a minute`],
    "installing-packages": [t`Installing LaTeX packages…`, t`This is the longest step and can take up to 15 minutes`],
    "installing-tools": [t`Installing required tools…`, t`Installing uv for paper imports and bibliography tools`],
    verifying: [t`Verifying installation…`, t`Almost done`],
    complete: [t`Finishing setup…`, t`Setup is complete`],
    "searching-packages": [t`Resolving…`, t`Checking…`],
    "installing-dependency": [t`Installing LaTeX packages…`, t`Download time depends on your connection`],
    "verifying-dependency": [t`Verifying installation…`, t`Almost done`],
  };
}

/** Shared layout of the LaTeX install dialogs: copy, native install progress, error, and actions. */
export function TexInstallDialog({ label, title, description, closeDisabled, onClose, progress, error, children }: {
  label: string;
  title: string;
  description: ReactNode;
  closeDisabled: boolean;
  onClose: () => void;
  /** `label` is the accessible name of the progress bar. */
  progress: { label: string; percent: number; stage: TexInstallStage } | null;
  error: string | null;
  children?: ReactNode;
}) {
  const [stage, detail] = useStageCopy()[progress?.stage ?? "complete"];
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
              <span>{stage} {progress.percent}%</span>
              <small>{detail}</small>
            </div>
          </div>
        )}
        {error && <InlineMessage level="error" className="tex-setup-status">{error}</InlineMessage>}
        {children}
      </PopIn>
    </ModalDialog>
  );
}
