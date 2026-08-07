import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Package, Wrench } from "lucide-react";
import {
  isConferenceFontsMissing,
  isTexToolchainMissing,
  TEX_INSTALL_SIZE_HINT,
  type DoctorReportLike,
} from "./tex-setup";
import { MotionButton, PopIn } from "./motion";
import { Button } from "./components/ui/button";
import { InfinityLoader, ReloadButton } from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import { ModalDialog } from "./components/ui/modal-dialog";
import { InlineMessage } from "./components/ui/inline-message";
import { logAction } from "./app-notify";

/** Notification source label for the LaTeX install wizard. */
const TEX_SETUP_SOURCE = "LaTeX setup";

type InstallKind = "basic" | "full";

export function TexSetupWizard(props: {
  open: boolean;
  report: DoctorReportLike | null;
  checking: boolean;
  statusMessage: string | null;
  onClose: () => void;
  onDismiss: () => void;
  onRecheck: () => void | Promise<void>;
}) {
  const [installing, setInstalling] = useState<InstallKind | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      setInstalling(null);
      setLocalStatus(null);
    }
  }, [props.open]);

  useEffect(() => {
    setLocalStatus(props.statusMessage);
  }, [props.statusMessage]);

  if (!props.open) return null;

  const toolsReady = props.report !== null && !isTexToolchainMissing(props.report);
  const fontsMissing = isConferenceFontsMissing(props.report);
  const ready = toolsReady && !fontsMissing;
  const busy = props.checking || installing !== null;
  const checked = props.report !== null && !props.checking;

  const startInstall = async (kind: InstallKind) => {
    setInstalling(kind);
    const trace = logAction(TEX_SETUP_SOURCE, "Install LaTeX", kind);
    try {
      await invoke("start_tex_install", { kind });
      trace.note("Installer launched in Terminal");
      setLocalStatus("Terminal opened. Click Recheck when it finishes.");
    } catch (reason) {
      trace.fail(reason);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <ModalDialog label="Install LaTeX tools" onClose={props.onClose} closeDisabled={busy} backdropClassName="tex-setup-backdrop">
      <PopIn
        className="modal tex-setup-modal"
      >
        <div className="modal-icon"><Wrench size={18} /></div>
        <h2>Install LaTeX to compile</h2>
        <p>
          Lattice opens Terminal and installs everything needed to compile PDFs.
        </p>

        {checked && !ready && (
          <InlineMessage level="error" className="tex-setup-banner">
            LaTeX is not installed on this Mac yet.
          </InlineMessage>
        )}

        {checked && ready && (
          <InlineMessage level="success" className="tex-setup-banner">
            LaTeX is ready. You can Build from the title bar.
          </InlineMessage>
        )}

        <div className="tex-setup-options">
          <button
            type="button"
            className="tex-setup-option"
            disabled={busy}
            onClick={() => { void startInstall("basic"); }}
          >
            <span className="tex-setup-option-icon"><Package size={16} /></span>
            <span className="tex-setup-option-copy">
              <strong>Install BasicTeX</strong>
              <span>About {TEX_INSTALL_SIZE_HINT.basic}. Recommended for most papers.</span>
            </span>
            {installing === "basic" && <InfinityLoader size={16} />}
          </button>
          <button
            type="button"
            className="tex-setup-option"
            disabled={busy}
            onClick={() => { void startInstall("full"); }}
          >
            <span className="tex-setup-option-icon"><Package size={16} /></span>
            <span className="tex-setup-option-copy">
              <strong>Install MacTeX (full)</strong>
              <span>About {TEX_INSTALL_SIZE_HINT.full}. Full TeX Live install.</span>
            </span>
            {installing === "full" && <InfinityLoader size={16} />}
          </button>
        </div>

        {(localStatus || props.checking) && (
          <InlineMessage level={ready ? "success" : "info"} className="tex-setup-status">
            {props.checking && !localStatus ? "Checking…" : localStatus}
          </InlineMessage>
        )}

        <div className="modal-actions tex-setup-actions">
          {!ready && (
            <Button variant="ghost" onClick={props.onDismiss} disabled={busy}>
              Skip for now
            </Button>
          )}
          <ReloadButton
            onClick={() => { void props.onRecheck(); }}
            busy={props.checking}
            disabled={busy}
          >
            Recheck
          </ReloadButton>
          <MotionButton
            type="button"
            className={buttonClassName({ variant: "primary" })}
            onClick={props.onClose}
            disabled={busy}
          >
            {ready ? "Done" : "Close"}
          </MotionButton>
        </div>
      </PopIn>
    </ModalDialog>
  );
}
