import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { Channel, invoke } from "@tauri-apps/api/core";
import { HardDrive, MinusCircle, Zap } from "lucide-react";
import { toMessage } from "../app-utils";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { restartLattice, runningWorkStoppedByRestart } from "../telemetry/app-restart";
import type { DownloadEvent, UpdateClaim } from "../telemetry/app-updater";
import { checkNativeApp, declineNativeApp, recordSwitchToNativeApp, releaseNativeApp, type NativeAppRelease } from "./native-app";
import "./native-app-dialog.css";

/**
 * Where the switch stands. `confirm` holds what a restart would stop until
 * the writer switches anyway; `installed` is a switch whose restart was called
 * off (a window could not save), so the native app opens at the next launch.
 */
type Step =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "offer" }
  | { kind: "confirm"; running: string }
  | { kind: "downloading"; progress: number | null }
  | { kind: "installing" }
  | { kind: "restarting" }
  | { kind: "installed" }
  | { kind: "failed"; reason: string | null };

type State = { release: NativeAppRelease | null; step: Step };

type Action = { type: "found"; release: NativeAppRelease | null } | { type: "step"; step: Step };

function reduce(state: State, action: Action): State {
  if (action.type === "found") return { release: action.release, step: action.release ? { kind: "offer" } : { kind: "unavailable" } };
  return { ...state, step: action.step };
}

/** Steps a close would cut short: the bundle is being replaced, or Lattice is restarting into it. */
const BUSY: ReadonlySet<Step["kind"]> = new Set(["downloading", "installing", "restarting"]);

/**
 * The offer to switch to the native Lattice: what it brings, what it lacks
 * yet, what becomes of this version's data, and Switch now, which downloads it
 * in place of this app and restarts into it. Opened with the release the
 * automatic offer found, or with none from Settings, which checks here.
 */
export function NativeAppDialog({ release: found, onClose }: { release: NativeAppRelease | null; onClose: () => void }) {
  const { t } = useLingui();
  const [{ release, step }, dispatch] = useReducer(reduce, { release: found, step: found ? { kind: "offer" } : { kind: "checking" } });
  const busy = BUSY.has(step.kind);

  useEffect(() => {
    if (step.kind !== "checking") return;
    let cancelled = false;
    void checkNativeApp().then((next) => {
      if (cancelled) {
        if (next) releaseNativeApp(next);
      } else dispatch({ type: "found", release: next });
    });
    return () => { cancelled = true; };
  }, [step.kind]);
  // The backend holds the release until told to let go of it.
  useEffect(() => () => { if (release) releaseNativeApp(release); }, [release]);

  const answer = (choice: "later" | "never") => {
    declineNativeApp(choice);
    onClose();
  };

  /**
   * Install the native app over this one, then restart into it. The claim is
   * the updater's own (app_restart.rs), under "native <version>" so a classic
   * release of the same number never reads as this install.
   */
  const switchNow = async (confirmed: boolean) => {
    if (!release || busy) return;
    if (!confirmed) {
      const running = await runningWorkStoppedByRestart();
      if (running) {
        dispatch({ type: "step", step: { kind: "confirm", running } });
        return;
      }
    }
    const version = `native ${release.version}`;
    const claim = await invoke<UpdateClaim>("claim_update_install", { version }).catch(() => "claimed" as const);
    if (claim === "busy") {
      dispatch({ type: "step", step: { kind: "failed", reason: null } });
      return;
    }
    if (claim === "claimed") {
      dispatch({ type: "step", step: { kind: "downloading", progress: null } });
      let total = 0;
      let received = 0;
      const channel = new Channel<DownloadEvent>();
      channel.onmessage = (event) => {
        if (event.event === "Started") total = event.data?.contentLength ?? 0;
        else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) dispatch({ type: "step", step: { kind: "downloading", progress: Math.min(1, received / total) } });
        } else dispatch({ type: "step", step: { kind: "installing" } });
      };
      try {
        await invoke("install_update", { version, rid: release.rid, onEvent: channel });
      } catch (reason) {
        dispatch({ type: "step", step: { kind: "failed", reason: toMessage(reason) } });
        return;
      }
    }
    recordSwitchToNativeApp();
    dispatch({ type: "step", step: { kind: "restarting" } });
    try {
      await restartLattice();
    } catch {
      // A window could not save an edit and says so itself; the native app
      // is in place and opens at the next launch, or on Restart now.
      dispatch({ type: "step", step: { kind: "installed" } });
    }
  };

  const running = step.kind === "confirm" ? step.running : "";
  const percent = step.kind === "downloading" && step.progress !== null ? Math.round(step.progress * 100) : null;
  const progressLabel = step.kind === "downloading"
    ? (percent === null ? t`Downloading the native Lattice…` : t`Downloading the native Lattice… ${percent}%`)
    : step.kind === "installing" ? t`Installing…` : t`Restarting…`;

  return (
    <ModalDialog label={t`Try the new native Lattice`} onClose={() => answer("later")} closeDisabled={busy}>
      <div className="modal whats-new-modal native-app-modal">
        <header className="whats-new-header">
          <h2>{t`Try the new native Lattice`}</h2>
        </header>
        <ol className="whats-new-list">
          <li>
            <span className="whats-new-icon" aria-hidden="true"><Zap size={15} aria-hidden /></span>
            <div>
              <strong>{t`What’s new`}</strong>
              <p>{t`Drawn natively by your Mac instead of as a web page: faster and lighter, with the same look and the same ways of working.`}</p>
              <p>{t`Your recent projects, settings, themes, plugins, templates, Agent skills and Overleaf links come along the first time you switch.`}</p>
              <p>{t`Your Agent conversations come along too, and any you start here later join them in the native app.`}</p>
            </div>
          </li>
          <li>
            <span className="whats-new-icon" aria-hidden="true"><MinusCircle size={15} aria-hidden /></span>
            <div>
              <strong>{t`Not there yet`}</strong>
              <p>{t`No grammar check and no dictionaries for other languages: spell check uses macOS’s own checker. Apple silicon Macs only.`}</p>
            </div>
          </li>
          <li>
            <span className="whats-new-icon" aria-hidden="true"><HardDrive size={15} aria-hidden /></span>
            <div>
              <strong>{t`Your data`}</strong>
              <p>{t`This version’s data stays as it is, and changes you make in the native app don’t come back here. If you switch back and later switch again, the native app keeps its own settings, themes, plugins and Overleaf session, and adds the recent projects you opened here.`}</p>
            </div>
          </li>
        </ol>
        <p className="native-app-note">{t`You can switch back any time from the native app’s Settings.`}</p>
        {busy && (
          <div className="native-app-progress" aria-live="polite">
            <div className="native-app-progress-track" role="progressbar" aria-label={t`Switch progress`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              <div className={percent === null ? "native-app-progress-fill native-app-progress-indeterminate" : "native-app-progress-fill"}
                style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
            <span>{progressLabel}</span>
          </div>
        )}
        {step.kind === "checking" && <InlineMessage>{t`Looking for the native Lattice…`}</InlineMessage>}
        {step.kind === "unavailable" && (
          <InlineMessage level="warning">{t`The native Lattice isn’t available right now. Check your connection and try again.`}</InlineMessage>
        )}
        {step.kind === "confirm" && <InlineMessage level="warning">{t`Switching restarts Lattice and stops ${running}.`}</InlineMessage>}
        {step.kind === "failed" && (
          <InlineMessage level="error">
            {step.reason ?? t`Another Lattice window is installing an update. Try again when it finishes.`}
          </InlineMessage>
        )}
        {step.kind === "installed" && (
          <InlineMessage level="success">{t`The native Lattice is installed and opens the next time Lattice starts.`}</InlineMessage>
        )}
        <div className="modal-actions native-app-actions">
          <Button variant="ghost" size="compact" disabled={busy} onClick={() => answer("never")}>{t`Don’t ask again`}</Button>
          <span className="native-app-actions-end">
            <Button variant="secondary" disabled={busy} onClick={() => answer("later")}>{t`Not now`}</Button>
            {step.kind === "unavailable" ? (
              <Button variant="primary" onClick={() => dispatch({ type: "step", step: { kind: "checking" } })} autoFocus>{t`Try again`}</Button>
            ) : step.kind === "installed" ? (
              <Button variant="primary" onClick={() => void switchNow(true)} autoFocus>{t`Restart now`}</Button>
            ) : (
              <Button variant="primary" disabled={!release || busy} onClick={() => void switchNow(step.kind === "confirm")} autoFocus>
                {step.kind === "confirm" ? t`Switch anyway` : step.kind === "failed" ? t`Try again` : t`Switch now`}
              </Button>
            )}
          </span>
        </div>
      </div>
    </ModalDialog>
  );
}
