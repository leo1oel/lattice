import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Wrench } from "lucide-react";
import {
  isConferenceFontsMissing,
  isTexToolchainMissing,
  TEX_INSTALL_SIZE_HINT,
  type DoctorReportLike,
  type TexInstallProgress,
} from "./tex-setup";
import { MotionButton, PopIn } from "./motion";
import { InfinityLoader } from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import { ModalDialog } from "./components/ui/modal-dialog";
import { InlineMessage } from "./components/ui/inline-message";
import { logAction } from "./app-notify";
import { toMessage } from "./app-utils";

/** Notification source label for the LaTeX install wizard. */
const TEX_SETUP_SOURCE = "LaTeX setup";

const INSTALL_STAGE_LABEL: Record<TexInstallProgress["stage"], string> = {
  downloading: "Downloading BasicTeX…",
  authorizing: "Waiting for administrator approval…",
  "installing-base": "Installing BasicTeX…",
  "installing-packages": "Installing LaTeX packages…",
  verifying: "Verifying installation…",
  complete: "Finishing setup…",
};

const INSTALL_STAGE_DETAIL: Record<TexInstallProgress["stage"], string> = {
  downloading: "Download time depends on your connection.",
  authorizing: "Approve the macOS prompt to continue.",
  "installing-base": "This step may take a minute.",
  "installing-packages": "This is the longest step and can take several minutes.",
  verifying: "Almost done.",
  complete: "Setup is complete.",
};

export function TexSetupWizard(props: {
  open: boolean;
  report: DoctorReportLike | null;
  checking: boolean;
  onClose: () => void;
  onRecheck: () => Promise<DoctorReportLike | null>;
}) {
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<TexInstallProgress>({
    stage: "downloading",
    progress: 0,
  });
  const [installError, setInstallError] = useState<string | null>(null);

  const { checking, onClose, open } = props;
  const toolsReady = props.report !== null && !isTexToolchainMissing(props.report);
  const ready = toolsReady && !isConferenceFontsMissing(props.report);

  useEffect(() => {
    if (open && ready && !checking && !installing) onClose();
  }, [checking, installing, onClose, open, ready]);

  if (!props.open) return null;

  const busy = props.checking || installing;

  const startInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    setInstallProgress({ stage: "downloading", progress: 0 });
    const trace = logAction(TEX_SETUP_SOURCE, "Install BasicTeX");
    try {
      const onProgress = new Channel<TexInstallProgress>();
      onProgress.onmessage = (progress) => setInstallProgress(progress);
      await invoke("start_tex_install", { onProgress });
      setInstallProgress({ stage: "complete", progress: 1 });
      const report = await props.onRecheck();
      if (!report || isTexToolchainMissing(report) || isConferenceFontsMissing(report)) {
        throw new Error("BasicTeX finished installing, but Lattice could not verify the LaTeX tools.");
      }
      trace.ok("BasicTeX installed");
      props.onClose();
    } catch (reason) {
      setInstallError(toMessage(reason));
      trace.fail(reason);
    } finally {
      setInstalling(false);
    }
  };

  const percent = Math.round(installProgress.progress * 100);

  return (
    <ModalDialog label="Install LaTeX tools" onClose={props.onClose} closeDisabled backdropClassName="tex-setup-backdrop">
      <PopIn
        className="modal tex-setup-modal"
      >
        <div className="modal-icon"><Wrench size={18} /></div>
        <h2>Install LaTeX to compile</h2>
        <p>
          BasicTeX is required to compile PDFs. Installation uses about {TEX_INSTALL_SIZE_HINT}
          {" "}and usually takes around 5 minutes.
        </p>

        {installing && (
          <div className="tex-setup-progress-block" aria-live="polite">
            <div
              className="tex-setup-progress"
              role="progressbar"
              aria-label="BasicTeX installation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="tex-setup-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="tex-setup-progress-copy">
              <span>{INSTALL_STAGE_LABEL[installProgress.stage]} {percent}%</span>
              <small>{INSTALL_STAGE_DETAIL[installProgress.stage]}</small>
            </div>
          </div>
        )}

        {installError && (
          <InlineMessage level="error" className="tex-setup-status">
            {installError}
          </InlineMessage>
        )}

        <MotionButton
          type="button"
          className={buttonClassName({ variant: "primary", className: "tex-setup-install" })}
          onClick={() => { void startInstall(); }}
          disabled={busy || ready}
        >
          {installing && <InfinityLoader className="tex-setup-install-loader" size={16} />}
          Install Basic TeX
        </MotionButton>
      </PopIn>
    </ModalDialog>
  );
}
