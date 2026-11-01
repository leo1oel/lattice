import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import { toMessage } from "../app-utils";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { notifyError, notifyWarning } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";

/**
 * The agent's provider CLIs inherit the proxy and provider settings the
 * sidecar started with (`src-tauri/src/synara/environment.rs`). A system
 * proxy turned on or changed afterwards reaches them only through a restart,
 * which stops running turns, so it is offered, never forced.
 */

/** Payload `{ stale }`: whether the running agent's proxy now differs from the system's. */
const ENVIRONMENT_CHANGED = "synara-environment-changed";
/** The agent stopped for a restart; every window using it starts it again. */
const RUNTIME_RESTARTED = "synara-runtime-restarted";
const RESTART_OFFER = "agent-environment-restart";

export function restartAgentRuntime(): Promise<void> {
  return invoke("synara_restart");
}

function offerRestart(stale: boolean) {
  if (!stale) {
    dismissAppToastByDedupeKey(RESTART_OFFER);
    return;
  }
  const source = i18n._(msg`Agent`);
  notifyWarning(source, i18n._(msg`The system proxy changed`), {
    detail: i18n._(msg`The agent still uses the proxy it started with. Restarting it stops any running turns.`),
    timeoutMs: 0,
    dedupeKey: RESTART_OFFER,
    primaryAction: {
      label: i18n._(msg`Restart agent`),
      onClick: () => restartAgentRuntime().catch((reason) => {
        notifyError(source, toMessage(reason));
      }),
    },
  });
}

/**
 * While this window uses the agent: offer a restart when the system proxy
 * moves away from what the agent started with, and start the agent again
 * (`onRestarted`) when any window restarts it.
 */
export function subscribeAgentEnvironment(onRestarted: () => void): () => void {
  const stopChanged = subscribeTauriEvent<{ stale: boolean }>(ENVIRONMENT_CHANGED, ({ stale }) => offerRestart(stale));
  const stopRestarted = subscribeTauriEvent(RUNTIME_RESTARTED, () => {
    dismissAppToastByDedupeKey(RESTART_OFFER);
    onRestarted();
  });
  return () => {
    stopChanged();
    stopRestarted();
  };
}
