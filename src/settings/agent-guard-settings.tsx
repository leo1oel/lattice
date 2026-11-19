import { useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsGroup } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { toMessage } from "../app-utils";

/** The writer's two opt-ins for the Linux sandbox (`synara/guard_options.rs`). */
type GuardOptions = {
  reducedIsolation: boolean;
  forwardSshAgent: boolean;
};

/** `synara_guard_options` and `synara_set_guard_options`. */
type GuardOptionsReport = GuardOptions & {
  /** Only the Linux sandbox reads the options; elsewhere there is nothing to show. */
  applies: boolean;
  /** This system cannot keep the sandbox from abstract sockets, so the agent is off until reduced isolation is on. */
  needsReducedIsolation: boolean;
};

type State = { report: GuardOptionsReport | null; error: string | null };

type Action =
  | { type: "loaded"; report: GuardOptionsReport | null }
  | { type: "saving"; options: GuardOptions }
  | { type: "saved"; report: GuardOptionsReport }
  | { type: "failed"; before: GuardOptionsReport; error: string };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "loaded": return { report: action.report, error: null };
    // The switch moves at once; the host's answer follows, or puts it back.
    case "saving": return state.report ? { report: { ...state.report, ...action.options }, error: null } : state;
    case "saved": return { report: action.report, error: null };
    case "failed": return { report: action.before, error: action.error };
  }
}

/**
 * Settings › Agent › Environment › Sandbox, on Linux: what the agent's
 * sandbox (`synara/bibliography_guard/linux.rs`) gives up when the writer
 * asks. Both are off until they turn them on, and the next agent start reads
 * them; Lattice starts the agent again by itself only when none was running,
 * as when its panel says it is off for want of the first one.
 */
export function AgentGuardSettings() {
  const { t } = useLingui();
  const [{ report, error }, dispatch] = useReducer(reduce, { report: null, error: null });
  // A save answered after a later one started must not put the older state back.
  const saves = useRef(0);

  useEffect(() => {
    let disposed = false;
    invoke<GuardOptionsReport | undefined>("synara_guard_options").then(
      (loaded) => { if (!disposed && saves.current === 0) dispatch({ type: "loaded", report: loaded ?? null }); },
      // Nothing to show without them; the page's own read reports a host that is not answering.
      () => undefined,
    );
    return () => { disposed = true; };
  }, []);

  if (!report?.applies) return null;

  const save = (change: Partial<GuardOptions>) => {
    const options: GuardOptions = { reducedIsolation: report.reducedIsolation, forwardSshAgent: report.forwardSshAgent, ...change };
    const save = ++saves.current;
    const before = report;
    dispatch({ type: "saving", options });
    invoke<GuardOptionsReport>("synara_set_guard_options", { options }).then(
      (saved) => { if (save === saves.current) dispatch({ type: "saved", report: saved }); },
      (reason) => { if (save === saves.current) dispatch({ type: "failed", before, error: toMessage(reason) }); },
    );
  };

  return (
    <SettingsGroup title={t`Sandbox`} data-setting="agent-sandbox">
      {error && <InlineMessage level="error">{error}</InlineMessage>}
      {/* Where the kernel has the scope there is nothing to give up, unless the switch was left on. */}
      {(report.needsReducedIsolation || report.reducedIsolation) && (
        <SwitchField
          data-setting="agent-reduced-isolation"
          label={t`Run the agent with reduced isolation`}
          description={report.needsReducedIsolation
            ? t`This system cannot keep the agent away from the X server and other abstract sockets on this computer; that needs Linux 6.12 or later. With this on the agent runs anyway and can reach them, so it could escape its sandbox and edit .bib files directly.`
            : t`This system keeps the agent away from abstract sockets by itself now, so this changes nothing here. You can turn it off.`}
          checked={report.reducedIsolation}
          onChange={(reducedIsolation) => save({ reducedIsolation })}
        />
      )}
      <SwitchField
        data-setting="agent-forward-ssh-agent"
        label={t`Let the agent use your SSH agent`}
        description={t`While this is off, git over SSH and signed commits do not work inside the agent. With it on, the agent can use every key your SSH agent holds, on any server those keys open.`}
        checked={report.forwardSshAgent}
        onChange={(forwardSshAgent) => save({ forwardSshAgent })}
      />
      <InlineMessage>{t`Changes here apply the next time the agent starts.`}</InlineMessage>
    </SettingsGroup>
  );
}
