import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { MotionButton } from "../components/ui/motion";
import { TexInstallDialog } from "./tex-install-dialog";
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
  const { stage, progress } = status.progress;

  return (
    <TexInstallDialog
      label={t`Install missing package`}
      title={t`Install missing package`}
      description={t`Lattice will find and install the TeX Live package that provides ${status.missingFile}.`}
      closeDisabled={status.installing}
      onClose={props.onClose}
      progress={{
        label: t`LaTeX package installation progress`,
        percent: Math.round(Math.min(1, Math.max(0, progress)) * 100),
        stage: stageLabel[stage],
        detail: stageDetail[stage],
      }}
      error={status.error}
    >
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
    </TexInstallDialog>
  );
}
