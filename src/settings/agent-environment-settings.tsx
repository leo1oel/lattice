import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../components/ui/button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { restartAgentRuntime } from "../agent/agent-environment";
import type { SynaraRuntimeInfo } from "../agent/synara-runtime";
import { toMessage } from "../app-utils";
import "./agent-environment-settings.css";

/** `synara_agent_environment`: values arrive redacted; the host never sees a key. */
type EnvironmentReport = {
  running: boolean;
  /** The running agent started with other values than a start would use now. */
  stale: boolean;
  shell: string;
  shellError: "timeout" | "failed" | null;
  variables: Array<{ name: string; value: string; source: "launch" | "shell" | "systemProxy" }>;
};

type State = {
  report: EnvironmentReport | null;
  /** A read is under way; the login shell can take seconds. */
  reading: boolean;
  restarting: boolean;
  /** Bumped by a finished restart, so the page reads again. */
  restarts: number;
  error: string | null;
};

type Action =
  | { type: "read" }
  | { type: "loaded"; report: EnvironmentReport }
  | { type: "failed"; error: string }
  | { type: "restart" }
  | { type: "restarted" };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "read": return { ...state, reading: true, error: null };
    case "loaded": return { ...state, reading: false, report: action.report };
    case "failed": return { ...state, reading: false, restarting: false, error: action.error };
    case "restart": return { ...state, restarting: true, error: null };
    case "restarted": return { ...state, restarting: false, restarts: state.restarts + 1 };
  }
}

/**
 * Settings › Agent › Environment: the proxy and provider variables the agent
 * receives, from the login shell and the system proxy, and a restart that
 * makes it read them again.
 */
export function AgentEnvironmentSettings(props: { runtime: SynaraRuntimeInfo }) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reduce, { report: null, reading: true, restarting: false, restarts: 0, error: null });
  // Read again whenever a new agent service starts: it may have picked up
  // what the last read reported as changed.
  const generation = props.runtime.authToken;

  useEffect(() => {
    let disposed = false;
    dispatch({ type: "read" });
    invoke<EnvironmentReport>("synara_agent_environment").then(
      (report) => { if (!disposed) dispatch({ type: "loaded", report }); },
      (reason) => { if (!disposed) dispatch({ type: "failed", error: toMessage(reason) }); },
    );
    return () => { disposed = true; };
  }, [generation, state.restarts]);

  const restart = () => {
    dispatch({ type: "restart" });
    restartAgentRuntime().then(
      () => dispatch({ type: "restarted" }),
      (reason) => dispatch({ type: "failed", error: toMessage(reason) }),
    );
  };

  const { report } = state;
  const sourceLabel = (source: EnvironmentReport["variables"][number]["source"]) =>
    source === "shell" ? t`From your login shell`
      : source === "systemProxy" ? t`From the macOS proxy settings`
        : t`From the environment Lattice was opened with`;
  const shell = report?.shell ?? "";
  const shellNotice = report?.shellError === "timeout"
    ? t`${shell} did not finish starting within 5 seconds, so its settings are missing. Check your shell startup files.`
    : report?.shellError === "failed" ? t`Couldn’t read the settings ${shell} exports, so they are missing.` : null;

  return (
    <div className="settings-section agent-environment-settings" aria-busy={state.reading}>
      <SettingsSectionHeader
        title={t`Environment`}
        description={t`Proxy settings and provider endpoints and keys, read from your login shell and the macOS network settings as a terminal would see them. Keys are shown shortened.`}
      />
      {state.error && <InlineMessage level="error">{state.error}</InlineMessage>}
      <SettingsGroup data-setting="agent-restart">
        <SettingsRow
          label={t`Agent service`}
          description={!report?.running
            ? t`The agent reads these each time it starts.`
            : report.stale
              ? t`The running agent started with different values. Restarting it stops any running turns.`
              : t`Restarting the agent stops any running turns.`}
        >
          {(state.reading || state.restarting) && <InfinityLoader size={14} />}
          {report?.running && (
            <Button
              size="compact"
              variant={report.stale ? "primary" : "secondary"}
              disabled={state.restarting}
              onClick={restart}
            >
              {t`Restart agent`}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t`Variables the agent receives`} data-setting="agent-environment">
        {shellNotice && <InlineMessage level="warning">{shellNotice}</InlineMessage>}
        {report && report.variables.length === 0 && (
          <SettingsRow label={t`None found`} description={t`Set HTTPS_PROXY or ANTHROPIC_BASE_URL in your shell startup file, or turn on a proxy in macOS, then restart the agent.`} />
        )}
        {report?.variables.map((variable) => (
          <SettingsRow
            key={variable.name}
            label={<code className="agent-environment-name">{variable.name}</code>}
            description={sourceLabel(variable.source)}
          >
            <code className="agent-environment-value" title={variable.value}>{variable.value}</code>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  );
}
