import { useCallback, useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import type { TexPackageUpdatesReport } from "../build/tex-package-updates";
import { TEX_PACKAGE_UPDATE_COMMAND, texPackageUpdateMessage } from "../build/tex-package-updates";
import { notifyError, notifyInfo, notifySuccess, notifyWarning, updateAppToastProgress } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useDailyTexPackageCheck, type TexPackageUpdates } from "./use-tex-package-updates";

const REMINDER_KEY = "lattice.tex-update-reminder.v1";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long "Later" keeps the reminder away. */
export const REMINDER_SNOOZE_MS = 3 * DAY_MS;
const REMINDER_TOAST_KEY = "tex-package-update-reminder";
const UPDATE_TOAST_KEY = "tex-package-update-run";

type ReminderRecord = { shownAt: number; snoozedUntil: number };

export function readReminderRecord(): ReminderRecord {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REMINDER_KEY) ?? "null");
    if (value && typeof value === "object") {
      const { shownAt, snoozedUntil } = value as Partial<ReminderRecord>;
      return { shownAt: Number(shownAt) || 0, snoozedUntil: Number(snoozedUntil) || 0 };
    }
  } catch {
    // Unreadable storage reminds as if it never had.
  }
  return { shownAt: 0, snoozedUntil: 0 };
}

function writeReminderRecord(change: Partial<ReminderRecord>) {
  try {
    localStorage.setItem(REMINDER_KEY, JSON.stringify({ ...readReminderRecord(), ...change }));
  } catch {
    // Without storage the daily check's own cadence still limits it to a launch.
  }
}

/** At most one reminder a day, and none while "Later" holds. */
function reminderDue(record: ReminderRecord, now: number): boolean {
  return now >= record.snoozedUntil && now - record.shownAt >= DAY_MS;
}

/** How many packages a check found outdated; 0 when it could not ask. */
function outdatedCount(report: TexPackageUpdatesReport | null): number {
  return report && !report.error ? report.packages.length : 0;
}

type State = {
  /** A daily check found updates and the reminder waits for a moment to show. */
  pending: boolean;
  /** The reminder is on screen (or was dismissed this launch). */
  shown: boolean;
};

type Action = { type: "found" } | { type: "shown" } | { type: "dropped" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "found":
      return state.shown ? state : { ...state, pending: true };
    case "shown":
      return { pending: false, shown: true };
    case "dropped":
      return { ...state, pending: false };
  }
}

/**
 * Tells the writer, in a toast, when the daily package check finds updates:
 * the Settings badge and the lineno build notice only reach someone already
 * looking there. The BasicTeX Lattice installed gets the doctor's one-click
 * update (behind the administrator prompt); a TeX the writer installed gets
 * the command, since Lattice does not change it.
 *
 * It never nags: once a launch at most (the check itself runs at most daily),
 * no sooner than a day after the last one, and "Later" keeps it away for
 * `REMINDER_SNOOZE_MS`. A build running when the check answers keeps it back
 * until the build ends, so it never lands over the build's own result, and
 * an update or a check that finds nothing left takes it down.
 */
export function useTexUpdateReminder(updates: TexPackageUpdates, building: boolean) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reducer, { pending: false, shown: false });
  const followingUpdateRef = useRef(false);
  const updateRef = useLatestRef(updates.update);

  const onChecked = useCallback((report: TexPackageUpdatesReport | null) => {
    if (outdatedCount(report) > 0 && reminderDue(readReminderRecord(), Date.now())) dispatch({ type: "found" });
  }, []);
  useDailyTexPackageCheck(updates.check, onChecked);

  const { report, run } = updates;
  const running = run?.running === true;
  const count = outdatedCount(report);

  useEffect(() => {
    if (!state.pending || building || running) return;
    // An update elsewhere (Settings, the build notice) may have left nothing to do.
    if (count === 0 || !report) {
      dispatch({ type: "dropped" });
      return;
    }
    writeReminderRecord({ shownAt: Date.now() });
    dispatch({ type: "shown" });
    const later = { label: t`Later`, onClick: () => writeReminderRecord({ snoozedUntil: Date.now() + REMINDER_SNOOZE_MS }) };
    const title = t`Your TeX packages are out of date`;
    if (report.managed) {
      notifyWarning(t`LaTeX setup`, title, {
        detail: t`Updates available (${count}). Updating asks for administrator approval and can take a few minutes.`,
        timeoutMs: 0,
        dedupeKey: REMINDER_TOAST_KEY,
        primaryAction: {
          label: t`Update TeX packages`,
          onClick: () => {
            followingUpdateRef.current = true;
            void updateRef.current();
          },
        },
        secondaryAction: later,
      });
    } else {
      notifyWarning(t`LaTeX setup`, title, {
        detail: t`Updates available (${count}). In Terminal: ${TEX_PACKAGE_UPDATE_COMMAND}`,
        copyText: TEX_PACKAGE_UPDATE_COMMAND,
        timeoutMs: 0,
        dedupeKey: REMINDER_TOAST_KEY,
        primaryAction: later,
      });
    }
  }, [building, count, report, running, state.pending, t, updateRef]);

  // Updating, or nothing left to update: the reminder has said its piece.
  useEffect(() => {
    if (state.shown && (running || (report && !report.error && count === 0))) dismissAppToastByDedupeKey(REMINDER_TOAST_KEY);
  }, [count, report, running, state.shown]);

  // An update started from the reminder reports where it stands, since the
  // reminder itself is gone and the doctor's progress lives in Settings.
  const stage = run?.progress.stage;
  const progress = run?.progress.progress ?? 0;
  const progressRef = useLatestRef(progress);
  const error = run?.error ?? null;
  const hasRun = run !== null;
  useEffect(() => {
    if (!followingUpdateRef.current || !hasRun) return;
    if (running) {
      const authorizing = stage === "authorizing";
      notifyInfo(t`LaTeX setup`, authorizing ? t`Waiting for administrator approval…` : t`Updating LaTeX packages…`, {
        detail: authorizing ? t`Approve the macOS prompt to continue` : t`Can take up to 15 minutes`,
        progress: progressRef.current,
        dedupeKey: UPDATE_TOAST_KEY,
      });
      return;
    }
    followingUpdateRef.current = false;
    if (error) {
      const failure = texPackageUpdateMessage(error);
      notifyError(t`LaTeX setup`, failure.summary, { detail: failure.detail, dedupeKey: UPDATE_TOAST_KEY });
    } else {
      notifySuccess(t`LaTeX setup`, t`TeX packages updated. Build again to use them.`, { dedupeKey: UPDATE_TOAST_KEY });
    }
  }, [error, hasRun, progressRef, running, stage, t]);
  // Progress moves the bar without a new notification; only stages make one.
  useEffect(() => {
    if (followingUpdateRef.current && running) updateAppToastProgress(UPDATE_TOAST_KEY, progress);
  }, [progress, running]);
}
