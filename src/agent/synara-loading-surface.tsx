import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, FolderOpen } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { CopyButton } from "../components/copy-button";
import { Button } from "../components/ui/button";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { StateSwap } from "../components/ui/motion";
import { redactLogText } from "../telemetry/app-log-store";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import { AgentPanelSkeleton } from "./agent-panel-skeleton";

/** How long the agent panel waits on the Agent before saying so and offering Retry. */
const SYNARA_SLOW_MS = 20_000;

export function SynaraLoadingSurface(props: {
  runtime: SynaraRuntimeInfo;
  preparingWorkspace?: boolean;
  onRetry: () => void;
  /**
   * The agent panel's shape: until the Agent answers, a skeleton of the
   * panel it is about to show rather than a centred mark, so the panel
   * lands where its shape already was.
   */
  thread?: boolean;
  /**
   * Whether the Agent has been asked for yet (the thread shape's frame is
   * mounted). Until then nothing is late: a panel kept behind another tab
   * does not start the Agent, nor its clock.
   */
  waiting?: boolean;
}) {
  const { t } = useLingui();
  const failed = props.runtime.state === "stopped";
  if (props.thread && !failed) {
    return (
      <SynaraThreadLoading
        message={props.preparingWorkspace ? t`Preparing this workspace` : t`Starting Agent`}
        waiting={props.waiting ?? true}
        onRetry={props.onRetry}
      />
    );
  }
  return (
    <div className="synara-loading-surface" role={failed ? "alert" : "status"} aria-live="polite">
      <span className={failed ? "synara-loading-mark failed" : "synara-loading-mark"} aria-hidden="true">
        <StateSwap swapKey={failed ? "failed" : "loading"}>
          {failed ? <CircleAlert size={17} /> : <InfinityLoader size={17} />}
        </StateSwap>
      </span>
      <div className="synara-loading-copy">
        <strong>
          <StateSwap swapKey={failed ? "failed" : props.preparingWorkspace ? "preparing" : "starting"}>
            {failed
              ? t`Agent unavailable`
              : props.preparingWorkspace
                ? t`Preparing this workspace`
                : t`Starting Agent`}
          </StateSwap>
        </strong>
        <span>
          {/* The runtime's own words go under Details: a startup failure
              quotes sidecar log lines, which read as noise in a headline
              and are not a diagnosis this surface can vouch for. */}
          {failed
            ? t`The bundled Agent service could not start`
            : props.preparingWorkspace
              ? t`Restoring the conversation surface…`
              : t`Warming the local service…`}
        </span>
      </div>
      {failed && <SynaraFailureActions runtime={props.runtime} onRetry={props.onRetry} />}
    </div>
  );
}

/**
 * The panel waiting on the Agent. The surface leaves only on the embed's
 * ready message, and a sidecar that never answers sends none, so after
 * SYNARA_SLOW_MS it says so and offers Retry and the logs, in the room the
 * suggestions' skeleton held; the rest of the skeleton stays, since the
 * Agent may yet answer. A retry starts the wait again.
 */
function SynaraThreadLoading({ message, waiting, onRetry }: { message: string; waiting: boolean; onRetry: () => void }) {
  const { t } = useLingui();
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlow(true), SYNARA_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, waiting]);
  const retry = () => {
    setSlow(false);
    setAttempt((value) => value + 1);
    onRetry();
  };
  // The unit stays with its number (a no-break space) when the note wraps.
  const seconds = SYNARA_SLOW_MS / 1000;
  return (
    <div className="synara-loading-surface" data-shape="thread" aria-busy={!slow}>
      <AgentPanelSkeleton bodyHidden={slow} />
      {slow ? (
        <div className="synara-slow" role="alert">
          <strong>{t`Taking longer than usual`}</strong>
          <span>{t`The Agent started ${seconds} s ago and hasn’t answered yet`}</span>
          <SynaraRecoveryActions onRetry={retry} />
        </div>
      ) : <LoadingAnnouncement message={message} />}
    </div>
  );
}

/** Retry, and the sidecar's logs: what a stalled or failed Agent offers. */
function SynaraRecoveryActions({ onRetry }: { onRetry: () => void }) {
  const { t } = useLingui();
  const [logsNote, setLogsNote] = useState<"missing" | "failed" | null>(null);
  const openLogs = () => {
    // The backend resolves the folder itself; the WebView never names a path.
    invoke<boolean>("synara_open_log_folder").then(
      (opened) => setLogsNote(opened ? null : "missing"),
      () => setLogsNote("failed"),
    );
  };
  return (
    <>
      <div className="synara-failure-actions">
        <ReloadButton size="compact" variant="tinted" onClick={onRetry}>
          {t`Retry`}
        </ReloadButton>
        <Button size="compact" onClick={openLogs}>
          <FolderOpen size={13} aria-hidden="true" />
          {t`Open logs`}
        </Button>
      </div>
      {logsNote && (
        <p className="synara-failure-note" role="status">
          {logsNote === "missing" ? t`No Agent logs yet` : t`Couldn’t open the logs`}
        </p>
      )}
    </>
  );
}

function SynaraFailureActions(props: { runtime: SynaraRuntimeInfo; onRetry: () => void }) {
  const { t } = useLingui();
  const message = props.runtime.message?.trim();
  const build = [props.runtime.version, props.runtime.revision?.slice(0, 12)].filter(Boolean).join(" · ");
  // What a writer pastes into a report. The startup excerpt is arbitrary
  // sidecar output, so credentials are stripped as the app log strips them.
  const copied = redactLogText([t`Agent unavailable`, message, build && t`Agent version ${build}`].filter(Boolean).join("\n"));
  return (
    <>
      <SynaraRecoveryActions onRetry={props.onRetry} />
      {message && (
        <details className="synara-failure-details">
          <summary>
            <ChevronRight size={12} aria-hidden="true" />
            {t({ message: "Details", context: "error disclosure" })}
          </summary>
          <div className="synara-failure-detail">
            <pre>{message}</pre>
            <CopyButton
              className="synara-failure-copy"
              text={copied}
              title={t`Copy details`}
              iconSize={12}
            />
          </div>
        </details>
      )}
    </>
  );
}
