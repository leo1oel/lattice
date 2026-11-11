import type { ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { isWindowsHost } from "../platform/host-platform";
import type { TexDependencyInstallProgress, TexInstallProgress } from "./tex-setup";
import { OutdatedVersionHint } from "../telemetry/outdated-version-hint";

type TexInstallStage = TexInstallProgress["stage"] | TexDependencyInstallProgress["stage"];

/** What each native install stage is doing, and what the writer can expect from it. */
function useStageCopy(): Record<TexInstallStage, readonly [stage: string, detail: string]> {
  const { t } = useLingui();
  // Windows installs TeX Live, macOS BasicTeX; the other stages read the same.
  const windows = isWindowsHost();
  return {
    downloading: [windows ? t`Downloading TeX Live…` : t`Downloading BasicTeX…`, ""],
    authorizing: [t`Waiting for administrator approval…`, t`Approve the macOS prompt to continue`],
    "installing-base": [windows ? t`Installing TeX Live…` : t`Installing BasicTeX…`, ""],
    "updating-base": [t`Updating LaTeX packages…`, t`Can take up to 15 minutes`],
    "installing-packages": [t`Installing LaTeX packages…`, t`Can take up to 15 minutes`],
    "installing-tools": [t`Installing required tools…`, ""],
    verifying: [t`Verifying installation…`, ""],
    complete: [t`Finishing setup…`, ""],
    "searching-packages": [t`Resolving…`, ""],
    "installing-dependency": [t`Installing LaTeX packages…`, ""],
    "verifying-dependency": [t`Verifying installation…`, ""],
  };
}

/** Shared layout of the LaTeX install dialogs: title, native install progress, error, and actions. */
export function TexInstallDialog({ label, title, description, closeDisabled, onClose, progress, error, errorDetail, children }: {
  label: string;
  title: string;
  /** A line under the title, only when it says what the title does not. */
  description?: ReactNode;
  closeDisabled: boolean;
  onClose: () => void;
  /** `label` is the accessible name of the progress bar. */
  progress: { label: string; percent: number; stage: TexInstallStage } | null;
  error: string | null;
  /** The installer's own words behind `error`, folded under it. */
  errorDetail?: string;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const [stage, detail] = useStageCopy()[progress?.stage ?? "complete"];
  return (
    <ModalDialog label={label} onClose={onClose} closeDisabled={closeDisabled} backdropClassName="tex-setup-backdrop">
      <div className={["modal", "tex-setup-modal"].join(" ")}>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
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
              {detail && <small>{detail}</small>}
            </div>
          </div>
        )}
        {error && <InlineMessage level="error" className="tex-setup-status">{error}</InlineMessage>}
        {error && <OutdatedVersionHint className="tex-setup-status" />}
        {error && errorDetail && (
          <details className="tex-setup-error-details">
            <summary>
              <ChevronRight size={12} aria-hidden="true" />
              {t({ message: "Details", context: "error disclosure" })}
            </summary>
            <pre>{errorDetail}</pre>
          </details>
        )}
        {children}
      </div>
    </ModalDialog>
  );
}
