import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import type { TexPackageUpdates } from "../app/use-tex-package-updates";
import { texPackageUpdateMessage } from "./tex-package-updates";

/**
 * A build notice's way to the TeX doctor's one-click package update
 * (`lineno-outdated`: a TeX installed before updates ran keeps lineno 5.7
 * until updated). The same update as Settings → TeX doctor, behind the same
 * administrator prompt, so either place shows its progress and result. A TeX
 * Lattice did not install answers with the command to run.
 */
export function TexPackageUpdateAction({ updates }: { updates: TexPackageUpdates }) {
  const { t } = useLingui();
  const { run } = updates;
  if (run?.running) {
    const percent = Math.round(run.progress.progress * 100);
    const waiting = run.progress.stage === "authorizing";
    return (
      <span className="compile-diagnostic-status" role="status">
        {waiting ? t`Waiting for administrator approval…` : t`Updating LaTeX packages…`} {percent}%
      </span>
    );
  }
  if (run && !run.error) {
    return <span className="compile-diagnostic-status" role="status">{t`TeX packages updated. Build again to use them.`}</span>;
  }
  const failure = run?.error ? texPackageUpdateMessage(run.error).summary : null;
  return (
    <>
      {failure && <span className="compile-diagnostic-status error" role="alert">{failure}</span>}
      <Button variant="ghost" size="compact" onClick={() => { void updates.update(); }}>
        {t`Update TeX packages`}
      </Button>
    </>
  );
}
