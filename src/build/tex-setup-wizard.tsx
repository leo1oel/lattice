import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  isConferenceFontsMissing,
  missingTexToolNames,
  missingRequiredToolNames,
  isRequiredSetupMissing,
  TEX_INSTALL_SIZE_HINT,
  type DoctorReportLike,
  type TexInstallProgress,
} from "./tex-setup";
import { TexInstallDialog } from "./tex-install-dialog";
import { MotionButton } from "../components/ui/motion";
import { InfinityLoader } from "../components/ui/activity-icons";
import { buttonClassName } from "../components/ui/button-styles";
import { logAction } from "../telemetry/app-notify";
import { toMessage } from "../app-utils";

/** Notification source label for the LaTeX install wizard. */
const TEX_SETUP_SOURCE = "LaTeX setup";

export function TexSetupWizard(props: {
  open: boolean;
  report: DoctorReportLike | null;
  checking: boolean;
  onClose: () => void;
  onRecheck: () => Promise<DoctorReportLike | null>;
}) {
  const { t } = useLingui();
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<TexInstallProgress>({ stage: "downloading", progress: 0 });
  const [installError, setInstallError] = useState<string | null>(null);

  const { checking, onClose, open } = props;
  const missingPaperTools = missingRequiredToolNames(props.report);
  const paperToolsOnly = props.report !== null
    && missingPaperTools.length > 0
    && missingTexToolNames(props.report).length === 0
    && !isConferenceFontsMissing(props.report);
  const ready = props.report !== null && !isRequiredSetupMissing(props.report);

  useEffect(() => {
    if (open && ready && !checking && !installing) onClose();
  }, [checking, installing, onClose, open, ready]);

  if (!props.open) return null;

  const busy = props.checking || installing;

  const startInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    setInstallProgress({ stage: paperToolsOnly ? "installing-tools" : "downloading", progress: 0 });
    const trace = logAction(TEX_SETUP_SOURCE, paperToolsOnly ? t`Install required paper tools` : t`Install BasicTeX`);
    try {
      const onProgress = new Channel<TexInstallProgress>();
      onProgress.onmessage = (progress) => setInstallProgress(progress);
      await invoke("start_tex_install", { mode: paperToolsOnly ? "toolsOnly" : "full", onProgress });
      setInstallProgress({ stage: "complete", progress: 1 });
      const installedProduct = paperToolsOnly ? t`The required tools` : "BasicTeX";
      const report = await props.onRecheck();
      if (!report) {
        throw new Error(t({
          message: `${installedProduct} finished installing, but Lattice could not run the final verification.`,
        }));
      }
      const missingTools = [...missingTexToolNames(report), ...missingRequiredToolNames(report)];
      const fontCheck = report.checks.find((check) => check.name === "conference-fonts");
      const issues = [
        ...(missingTools.length > 0 ? [t`Missing tools: ${missingTools.join(", ")}`] : []),
        ...(fontCheck?.ok !== true ? [fontCheck?.detail ?? t`Conference font verification is missing.`] : []),
      ];
      if (issues.length > 0) {
        throw new Error(t({
          message: `${installedProduct} finished installing, but Lattice could not verify:\n${issues.join("\n")}`,
        }));
      }
      trace.ok(paperToolsOnly ? t`Required paper tools installed` : t`BasicTeX installed`);
      props.onClose();
    } catch (reason) {
      setInstallError(toMessage(reason));
      trace.fail(reason);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <TexInstallDialog
      label={t`Install LaTeX tools`}
      title={paperToolsOnly ? t`Install required paper tools` : t`Install LaTeX to compile`}
      description={paperToolsOnly
        ? t({ message: "Lattice needs uv to add papers and manage bibliographies. The verified download uses about 45 MB and usually installs in under a minute" })
        : t({ message: `BasicTeX and Lattice’s required paper tools use about ${TEX_INSTALL_SIZE_HINT} after installation. Initial setup can take up to 15 minutes` })}
      closeDisabled
      onClose={props.onClose}
      progress={installing ? {
        label: paperToolsOnly ? t`Required tools installation progress` : t`BasicTeX installation progress`,
        percent: Math.round(installProgress.progress * 100),
        stage: installProgress.stage,
      } : null}
      error={installError}
    >
      <MotionButton
        type="button"
        className={buttonClassName({ variant: "primary", className: "tex-setup-install" })}
        onClick={() => { void startInstall(); }}
        disabled={busy || ready}
      >
        {installing && <InfinityLoader className="tex-setup-install-loader" size={16} />}
        {paperToolsOnly ? t`Install required tools` : t`Install Basic TeX`}
      </MotionButton>
    </TexInstallDialog>
  );
}
