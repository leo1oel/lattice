import { useEffect } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import type { TexPackageUpdates } from "../app/use-tex-package-updates";
import { TEX_PACKAGE_UPDATE_COMMAND, texPackageUpdateMessage } from "../build/tex-package-updates";
import { texPackageCheckProblem } from "./tex-package-check-problem";

/** Package names the row spells out before it only counts the rest. */
const NAMED_PACKAGES = 3;

/**
 * The doctor's "TeX packages" check, an item of its checklist: whether the
 * installed packages have updates. A TeX that Lattice did not install gets
 * the command to run, since Lattice does not change it. Checks on mounting,
 * as the page itself does: a TeX that was current last week may not be now.
 */
export function TexPackageUpdatesCheck({ updates }: { updates: TexPackageUpdates }) {
  const { t } = useLingui();
  const { report, checking, check } = updates;
  useEffect(() => {
    void check();
  }, [check]);

  const packages = report?.error ? [] : report?.packages ?? [];
  const count = packages.length;
  const named = packages.slice(0, NAMED_PACKAGES)
    .map(({ name, installed, available }) => `${name} ${installed} → ${available}`)
    .join(", ");
  const more = count - NAMED_PACKAGES;

  // Nothing until the repository first answers; then, like the other
  // checks, a current TeX is a compact row and only a problem says more. It
  // stays a problem while an update runs, until the recheck after it.
  if (!report) return null;
  const problem = report.error ? texPackageCheckProblem(report.error) : null;
  let detail: string | null = null;
  let result = t`Up to date`;
  if (problem) {
    detail = problem.summary;
    result = t`Couldn’t check for updates`;
  } else if (count > 0) {
    detail = more > 0 ? t`Updates available (${count}): ${named}, and ${more} more` : t`Updates available (${count}): ${named}`;
    result = t`Updates available`;
  }

  return (
    <li className={detail ? "warn" : "ok"} aria-busy={checking}>
      {detail ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
      <strong>{t`TeX packages`}</strong>
      {/* For assistive technology only, as in the other checks. */}
      <span className="doctor-check-result">{result}</span>
      {detail && <span className="doctor-check-detail">{detail}</span>}
      {problem?.detail && <pre className="doctor-check-detail doctor-package-update-detail">{problem.detail}</pre>}
      {count > 0 && !report.managed && (
        <span className="doctor-check-detail">
          {t`In Terminal:`} <code>{TEX_PACKAGE_UPDATE_COMMAND}</code>
        </span>
      )}
    </li>
  );
}

/**
 * Under the checklist, for the BasicTeX Lattice installed: the one-click
 * update, its progress, and its result.
 */
export function TexPackageUpdatesActions({ updates, disabled }: { updates: TexPackageUpdates; disabled: boolean }) {
  const { t } = useLingui();
  const { report, run } = updates;
  const running = run?.running === true;
  const offer = !running && !updates.checking && !report?.error && report?.managed === true && report.packages.length > 0;
  const failure = run?.error ? texPackageUpdateMessage(run.error) : null;
  if (!offer && !run) return null;
  const percent = Math.round((run?.progress.progress ?? 0) * 100);
  const authorizing = run?.progress.stage === "authorizing";
  return (
    <div className="doctor-package-updates">
      {offer && (
        <div className="settings-api-actions">
          <Button disabled={disabled} onClick={() => { void updates.update(); }}>
            {t`Update TeX packages`}
          </Button>
        </div>
      )}
      {running && (
        <div className="tex-setup-progress-block" aria-live="polite">
          <div
            className="tex-setup-progress"
            role="progressbar"
            aria-label={t`TeX package update progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="tex-setup-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="tex-setup-progress-copy">
            <span>{authorizing ? t`Waiting for administrator approval…` : t`Updating LaTeX packages…`} {percent}%</span>
            <small>{authorizing ? t`Approve the macOS prompt to continue` : t`Can take up to 15 minutes`}</small>
          </div>
        </div>
      )}
      {run && !running && !failure && (
        <InlineMessage level="success" className="settings-inline">{t`TeX packages updated. Build again to use them.`}</InlineMessage>
      )}
      {failure && (
        <InlineMessage level="error" className="settings-inline">
          {failure.summary}
          {failure.detail && <pre className="doctor-package-update-detail">{failure.detail}</pre>}
        </InlineMessage>
      )}
    </div>
  );
}
