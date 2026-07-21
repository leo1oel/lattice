import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  Package,
  RefreshCw,
  Wrench,
} from "lucide-react";
import {
  isConferenceFontsMissing,
  isTexToolchainMissing,
  TEX_INSTALL_SIZE_HINT,
  type DoctorReportLike,
} from "./tex-setup";

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
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      setInstalling(null);
      setLocalStatus(null);
      setLocalError(null);
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
    setLocalError(null);
    setInstalling(kind);
    try {
      await invoke("start_tex_install", { kind });
      setLocalStatus(
        "Terminal opened. When it finishes, click Recheck here. Already-installed pieces are skipped.",
      );
    } catch (reason) {
      const message = typeof reason === "string"
        ? reason
        : reason instanceof Error
          ? reason.message
          : String(reason);
      setLocalError(message);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="modal-backdrop tex-setup-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal tex-setup-modal"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Install LaTeX tools"
      >
        <div className="modal-icon"><Wrench size={18} /></div>
        <h2>Install LaTeX to compile</h2>
        <p>
          Pick one option. Lattice opens Terminal and installs everything needed for PDF compile.
        </p>

        {checked && !ready && (
          <div className="tex-setup-banner bad" role="alert">
            <CircleAlert size={16} />
            <span>LaTeX is not ready on this Mac yet. Click Install BasicTeX below (or MacTeX if you prefer the full install).</span>
          </div>
        )}

        {checked && ready && (
          <div className="tex-setup-banner ok" role="status">
            <Check size={16} />
            <span>LaTeX is ready. You can Build from the title bar.</span>
          </div>
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
              <span>
                About {TEX_INSTALL_SIZE_HINT.basic}. Recommended for most papers.
                Safe to click again if something is still missing.
              </span>
            </span>
            {installing === "basic" && <LoaderCircle className="spin" size={16} />}
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
            {installing === "full" && <LoaderCircle className="spin" size={16} />}
          </button>
        </div>

        {(localStatus || props.checking) && (
          <p className={`tex-setup-status ${ready ? "ok" : "info"}`} role="status">
            {props.checking && !localStatus ? "Checking…" : localStatus}
          </p>
        )}

        {localError && (
          <p className="tex-setup-status danger" role="alert">{localError}</p>
        )}

        <div className="modal-actions tex-setup-actions">
          {!ready && (
            <button type="button" className="text-button" onClick={props.onDismiss} disabled={busy}>
              Skip for now
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => { void props.onRecheck(); }}
            disabled={busy}
          >
            {props.checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            Recheck
          </button>
          <button type="button" className="primary-button" onClick={props.onClose} disabled={installing !== null}>
            {ready ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
