import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { MotionButton } from "../components/ui/motion";
import { TexInstallDialog } from "./tex-install-dialog";
import { texDependencyInstallFailure, type TexDependencyInstallProgress } from "./tex-setup";

export type TexDependencyInstallStatus = {
  missingFile: string;
  progress: TexDependencyInstallProgress;
  installing: boolean;
  error: string | null;
  /** Several TeX Live packages provide the file equally well: the writer picks one. */
  packages?: readonly string[];
};

export function TexDependencyInstaller(props: {
  status: TexDependencyInstallStatus | null;
  onClose: () => void;
  /** `texPackage` is the writer's pick from `status.packages`. */
  onRetry: (missingFile: string, texPackage?: string) => void;
}) {
  const { t } = useLingui();
  const status = props.status;
  if (!status) return null;
  const failure = status.error ? texDependencyInstallFailure(status.error) : null;
  const packages = !status.installing && !status.error ? status.packages : undefined;
  return (
    <TexInstallDialog
      label={t`Install missing package`}
      title={t`Install package for ${status.missingFile}`}
      closeDisabled={status.installing}
      description={packages && t`Several TeX Live packages provide ${status.missingFile}. Choose the one to install.`}
      onClose={props.onClose}
      progress={packages ? null : {
        label: t`LaTeX package installation progress`,
        percent: Math.round(Math.min(1, Math.max(0, status.progress.progress)) * 100),
        stage: status.progress.stage,
      }}
      error={failure?.summary ?? null}
      errorDetail={failure?.detail}
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
      {packages && (
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
          {packages.map((name) => (
            <Button key={name} onClick={() => props.onRetry(status.missingFile, name)}>{name}</Button>
          ))}
        </div>
      )}
    </TexInstallDialog>
  );
}
