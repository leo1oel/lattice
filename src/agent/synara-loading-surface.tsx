import { useState } from "react";
import { ChevronRight, CircleAlert, FolderOpen } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { CopyButton } from "../components/copy-button";
import { Button } from "../components/ui/button";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { StateSwap } from "../components/ui/motion";
import { redactLogText } from "../telemetry/app-log-store";

export function SynaraLoadingSurface(props: {
  runtime: SynaraRuntimeInfo;
  preparingWorkspace?: boolean;
  onRetry: () => void;
}) {
  const { t } = useLingui();
  const failed = props.runtime.state === "stopped";
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

function SynaraFailureActions(props: { runtime: SynaraRuntimeInfo; onRetry: () => void }) {
  const { t } = useLingui();
  const [logsMissing, setLogsMissing] = useState(false);
  const message = props.runtime.message?.trim();
  const openLogs = () => {
    // The backend resolves the folder itself; the WebView never names a path.
    invoke("synara_open_log_folder").then(() => setLogsMissing(false), () => setLogsMissing(true));
  };
  const build = [props.runtime.version, props.runtime.revision?.slice(0, 12)].filter(Boolean).join(" · ");
  // What a writer pastes into a report. The startup excerpt is arbitrary
  // sidecar output, so credentials are stripped as the app log strips them.
  const copied = redactLogText([t`Agent unavailable`, message, build && t`Agent version ${build}`].filter(Boolean).join("\n"));
  return (
    <>
      <div className="synara-failure-actions">
        <ReloadButton size="compact" variant="primary" onClick={props.onRetry}>
          {t`Retry`}
        </ReloadButton>
        <Button size="compact" onClick={openLogs}>
          <FolderOpen size={13} aria-hidden="true" />
          {t`Open logs`}
        </Button>
      </div>
      {logsMissing && <p className="synara-failure-note" role="status">{t`No Agent logs yet`}</p>}
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
