/**
 * The agent runtime's version, and updating it in place.
 *
 * Oh My Pi (and the `pi` native module it loads) ships far more often than
 * Lattice does, and new models land there first. The copy inside the app
 * bundle cannot be replaced — that would invalidate the app's signature — so a
 * newer one installs beside it and is preferred at launch, with the bundled
 * copy still there as the floor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Download, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import type { AgentRuntimeStatus } from "./app-types";
import { toMessage } from "./app-utils";
import { addAppLog } from "./app-log";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Field } from "./components/ui/field";
import { Button } from "./components/ui/button";
import { IconButton } from "./components/ui/icon-button";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";

export type RuntimeUpdateMode = "auto" | "manual";

const MODE_KEY = "lattice.agent-runtime.update-mode.v1";
/** Same cadence as the app's own updater, and once on launch. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Automatic by default, like the app itself.
 *
 * A runtime that lags behind is not a neutral state: models the runtime does
 * not know about cannot be chosen, so leaving it alone quietly costs the
 * feature people came for.
 */
export function getRuntimeUpdateMode(): RuntimeUpdateMode {
  try {
    return localStorage.getItem(MODE_KEY) === "manual" ? "manual" : "auto";
  } catch {
    return "auto";
  }
}

function persistRuntimeUpdateMode(mode: RuntimeUpdateMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage unavailable — the choice still applies for this session.
  }
}

/**
 * Keeps the agent runtime current in the background.
 *
 * Mount once, near the top of the app. It checks on launch and every six
 * hours, and installs without asking when the mode is automatic — the runtime
 * is an implementation detail of the agent, not something anyone wants to be
 * consulted about. The download is large, so it never runs twice at once, and
 * a failure is silent: the previous runtime is still there and still works.
 */
export function useAgentRuntimeUpdates(options: { onUpdated: () => void }) {
  const running = useRef(false);
  const onUpdated = useRef(options.onUpdated);
  onUpdated.current = options.onUpdated;

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped || running.current || getRuntimeUpdateMode() !== "auto") return;
      running.current = true;
      void invoke<AgentRuntimeStatus>("agent_runtime_status")
        .then((status) => (status.updateAvailable
          ? invoke<string>("agent_runtime_update").then(() => onUpdated.current())
          : undefined))
        .catch((reason) => {
          addAppLog({
            level: "warning",
            source: "Agent runtime",
            title: "Couldn’t update the agent runtime",
            detail: toMessage(reason),
          });
        })
        .finally(() => {
          running.current = false;
        });
    };
    const timer = window.setInterval(tick, CHECK_INTERVAL_MS);
    // Not on the first paint: the launch is busy enough without a 260 MB
    // download starting underneath it.
    const initial = window.setTimeout(tick, 20_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(initial);
    };
  }, []);
}

export function AgentRuntimeSettings(props: {
  /** Called after an update, so the model list is asked again. */
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [mode, setMode] = useState<RuntimeUpdateMode>(getRuntimeUpdateMode);
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
    .catch((reason) => {
      const detail = toMessage(reason);
      setError(detail);
      addAppLog({ level: "error", source: "Agent runtime", title: "Couldn’t check the agent runtime", detail });
    }), []);

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
      addAppLog({ level: "success", source: "Agent runtime", title: `Agent runtime ${version} installed` });
      props.onUpdated();
      await check();
    } catch (reason) {
      const detail = toMessage(reason);
      setError(detail);
      addAppLog({ level: "error", source: "Agent runtime", title: "Agent runtime update failed", detail });
    }
    setInstalling(false);
  };

  const revert = async () => {
    setError(null);
    setNotice(null);
    try {
      await invoke("agent_runtime_revert");
      setNotice("Back on the runtime that ships with Lattice.");
      addAppLog({ level: "success", source: "Agent runtime", title: "Restored the bundled agent runtime" });
      props.onUpdated();
      await load();
    } catch (reason) {
      const detail = toMessage(reason);
      setError(detail);
      addAppLog({ level: "error", source: "Agent runtime", title: "Couldn’t restore the bundled runtime", detail });
    }
  };

  return (
    // A block within Subscriptions, not a page of its own: nesting a second
    // `.settings-section` here indented everything below it by that section's
    // own padding, so the runtime heading and its controls sat to the right of
    // every other setting on the page.
    <div className="settings-subsection">
      <SettingsSectionHeader
        title="Agent runtime"
        description="Oh My Pi runs the agent and decides which models are available."
        actions={(
          <IconButton
            label="Check for a newer runtime"
            disabled={checking || installing}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="spin" /> : <RefreshCw />}
          </IconButton>
        )}
      />

      <div className="account-list">
        <div className="account-card">
          <div className="account-mark connected">π</div>
          <div>
            <strong>Oh My Pi {status?.current ?? "…"}</strong>
            <small role={status?.detail ? "alert" : undefined}>
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

      {/* A plain label, like every other setting: caption above, control
          below, both on the page's left edge. The right-aligned variant this
          used stood out as the one row that did not line up. */}
      <Field label="Runtime updates">
        <Select
          value={mode}
          onValueChange={(value) => {
            setMode(value as RuntimeUpdateMode);
            persistRuntimeUpdateMode(value as RuntimeUpdateMode);
          }}
        >
          <SelectTrigger aria-label="Runtime updates"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value="auto">Install automatically</SelectItem>
            <SelectItem value="manual">Only when I ask</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {status && status.current !== status.bundled && (
        <Button
          size="compact"
          disabled={installing}
          onClick={() => void revert()}
        >
          <RotateCcw size={12} /> Go back to the bundled {status.bundled}
        </Button>
      )}

      {installing && (
        <p className="settings-notice">
          Downloading about 260 MB — the runtime and its native module. You can keep working;
          the agent uses the current one until this finishes.
        </p>
      )}
      {notice && <p className="settings-notice" role="status">{notice}</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  );
}
