/**
 * The agent runtime's version, and updating it in place.
 *
 * Oh My Pi (and the `pi` native module it loads) ships far more often than
 * Lattice does, and new models land there first. The copy inside the app
 * bundle cannot be replaced — that would invalidate the app's signature — so a
 * newer one installs beside it and is preferred at launch, with the bundled
 * copy still there as the floor.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Download, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import type { AgentRuntimeStatus } from "./app-types";
import { toMessage } from "./app-utils";

export function AgentRuntimeSettings(props: {
  /** Called after an update, so the model list is asked again. */
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reads the status without touching state until an answer comes back, so
  // the mount effect below does not set state on the way in.
  const load = useCallback(() => invoke<AgentRuntimeStatus>("agent_runtime_status")
    .then((next) => {
      setStatus(next);
      setError(null);
    })
    .catch((reason) => setError(toMessage(reason))), []);

  const check = useCallback(async () => {
    setChecking(true);
    await load();
    setChecking(false);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    setNotice(null);
    try {
      const version = await invoke<string>("agent_runtime_update");
      setNotice(`Agent runtime ${version} installed. It is used from the next message on.`);
      props.onUpdated();
      await check();
    } catch (reason) {
      setError(toMessage(reason));
    }
    setInstalling(false);
  };

  const revert = async () => {
    setError(null);
    setNotice(null);
    try {
      await invoke("agent_runtime_revert");
      setNotice("Back on the runtime that ships with Lattice.");
      props.onUpdated();
      await load();
    } catch (reason) {
      setError(toMessage(reason));
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">
        <div>
          <h2>Agent runtime</h2>
          <p>Oh My Pi runs the agent and decides which models are available.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Check for a newer runtime"
          disabled={checking || installing}
          onClick={() => void check()}
        >
          {checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="account-list">
        <div className="account-card">
          <div className="account-mark connected">π</div>
          <div>
            <strong>Oh My Pi {status?.current ?? "…"}</strong>
            <small>
              {!status && "Reading the installed runtime…"}
              {status?.detail && `Could not check for updates: ${status.detail}`}
              {status && !status.detail && status.updateAvailable
                && `Version ${status.latest} is available.`}
              {status && !status.detail && !status.updateAvailable
                && "This is the newest release."}
              {status && status.current !== status.bundled
                && ` Installed alongside the bundled ${status.bundled}.`}
            </small>
          </div>
          {status?.updateAvailable && (
            <button type="button" disabled={installing} onClick={() => void install()}>
              {installing
                ? <><LoaderCircle className="spin" size={12} /> Installing…</>
                : <><Download size={12} /> Update</>}
            </button>
          )}
          {status && !status.updateAvailable && !status.detail && (
            <span className="connected-label"><Check size={12} /> Current</span>
          )}
        </div>
      </div>

      {status && status.current !== status.bundled && (
        <button
          type="button"
          className="secondary-button"
          disabled={installing}
          onClick={() => void revert()}
        >
          <RotateCcw size={12} /> Go back to the bundled {status.bundled}
        </button>
      )}

      {installing && (
        <p className="settings-notice">
          Downloading about 260 MB — the runtime and its native module. You can keep working;
          the agent uses the current one until this finishes.
        </p>
      )}
      {notice && <p className="settings-notice">{notice}</p>}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}
