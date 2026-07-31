import { CircleAlert } from "lucide-react";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { InfinityLoader, ReloadButton } from "./components/ui/activity-icons";

export function SynaraLoadingSurface(props: {
  runtime: SynaraRuntimeInfo;
  preparingWorkspace?: boolean;
  onRetry: () => void;
}) {
  const failed = props.runtime.state === "stopped";
  return (
    <div className="synara-loading-surface" role={failed ? "alert" : "status"} aria-live="polite">
      <span className={failed ? "synara-loading-mark failed" : "synara-loading-mark"} aria-hidden="true">
        {failed ? <CircleAlert size={17} /> : <InfinityLoader size={17} />}
      </span>
      <div className="synara-loading-copy">
        <strong>
          {failed
            ? "Agent unavailable"
            : props.preparingWorkspace
              ? "Preparing this workspace"
              : "Starting Agent"}
        </strong>
        <span>
          {failed
            ? props.runtime.message || "The bundled Agent service could not start."
            : props.preparingWorkspace
              ? "Restoring the conversation surface…"
              : "Warming the local service…"}
        </span>
      </div>
      {failed && (
        <ReloadButton size="compact" onClick={props.onRetry}>
          Retry
        </ReloadButton>
      )}
    </div>
  );
}
