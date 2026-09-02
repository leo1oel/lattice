import { useLingui } from "@lingui/react/macro";
import { Wrench } from "lucide-react";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { MotionButton, PopIn } from "../components/ui/motion";
import type { TexDependencyInstallProgress } from "./tex-setup";

export type TexDependencyInstallStatus = {
  missingFile: string;
  progress: TexDependencyInstallProgress;
  installing: boolean;
  error: string | null;
};

export function TexDependencyInstaller(props: {
  status: TexDependencyInstallStatus | null;
  onClose: () => void;
  onRetry: (missingFile: string) => void;
}) {
  const { t } = useLingui();
  const status = props.status;
  if (!status) return null;

  const stageLabel: Record<TexDependencyInstallProgress["stage"], string> = {
    "searching-packages": t`Resolving…`,
    authorizing: t`Waiting for administrator approval…`,
    "installing-dependency": t`Installing LaTeX packages…`,
    "verifying-dependency": t`Verifying installation…`,
    complete: t`Finishing setup…`,
  };
  const stageDetail: Record<TexDependencyInstallProgress["stage"], string> = {
    "searching-packages": t`Checking…`,
    authorizing: t`Approve the macOS prompt to continue`,
    "installing-dependency": t`Download time depends on your connection`,
    "verifying-dependency": t`Almost done`,
    complete: t`Setup is complete`,
  };
  const percent = Math.round(Math.min(1, Math.max(0, status.progress.progress)) * 100);

  return (
    <ModalDialog
      label={t`Install missing package`}
      onClose={props.onClose}
      closeDisabled={status.installing}
      backdropClassName="tex-setup-backdrop"
    >
      <PopIn className={["modal", "tex-setup-modal"].join(" ")}>
        <div className="modal-icon"><Wrench size={18} /></div>
        <h2>{t`Install missing package`}</h2>
        <p>
          {t`Lattice will find and install the TeX Live package that provides ${status.missingFile}.`}
        </p>

        <div className="tex-setup-progress-block" aria-live="polite">
          <div
            className="tex-setup-progress"
            role="progressbar"
            aria-label={t`LaTeX package installation progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="tex-setup-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="tex-setup-progress-copy">
            <span>{stageLabel[status.progress.stage]} {percent}%</span>
            <small>{stageDetail[status.progress.stage]}</small>
          </div>
        </div>

        {status.error && (
          <InlineMessage level="error" className="tex-setup-status">
            {status.error}
          </InlineMessage>
        )}

        {!status.installing && status.error && (
          <div className="modal-actions">
            <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
            <MotionButton
              type="button"
              className={buttonClassName({ variant: "primary" })}
              onClick={() => props.onRetry(status.missingFile)}
            >
              {t`Try again`}
            </MotionButton>
          </div>
        )}
      </PopIn>
    </ModalDialog>
  );
}
