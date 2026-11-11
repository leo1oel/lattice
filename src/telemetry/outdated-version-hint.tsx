// The line a failure surface shows while a newer Lattice is known; see
// outdated-version.ts for where that knowledge comes from.

import { useLingui } from "@lingui/react/macro";
import { InlineMessage } from "../components/ui/inline-message";
import { buttonClassName } from "../components/ui/button-styles";
import { useKnownUpdate } from "./outdated-version";

const BUSY = new Set(["checking", "downloading", "installing", "restarting"]);

/** The one line a failure surface adds while Lattice is out of date; nothing while it is current. */
export function OutdatedVersionHint({ className }: { className?: string }) {
  const { t } = useLingui();
  const update = useKnownUpdate();
  if (!update) return null;
  const { running, latest, phase } = update;
  const busy = BUSY.has(phase);
  return (
    <InlineMessage className={`outdated-version-hint${className ? ` ${className}` : ""}`}>
      <span>{t`You’re on v${running}; v${latest} is available and may already fix this.`}</span>
      <button
        type="button"
        className={buttonClassName({ size: "compact", variant: "tinted" })}
        disabled={busy}
        onClick={() => void update.updateNow()}
      >
        {phase === "ready" ? t`Restart to update` : busy ? t`Updating…` : t`Update now`}
      </button>
    </InlineMessage>
  );
}
