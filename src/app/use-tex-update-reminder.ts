import { useCallback, useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import type { TexPackageUpdatesReport } from "../build/tex-package-updates";
import { TEX_PACKAGE_UPDATE_COMMAND, texPackageUpdateMessage } from "../build/tex-package-updates";
import { notifyError, notifyInfo, notifySuccess, notifyWarning, updateAppToastProgress } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useWeeklyTexPackageCheck, type TexPackageUpdates } from "./use-tex-package-updates";

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
  /**
   * A weekly check found updates and waits for a moment without a build:
   * to show the reminder, or to install them unasked when the writer owns
   * the TeX tree and so no password is needed.
   */
  pending: "remind" | "install" | null;
  /** The reminder is on screen (or was dismissed this launch). */
  shown: boolean;
};

type Action = { type: "found"; install: boolean } | { type: "shown" } | { type: "dropped" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "found":
      if (action.install) return { ...state, pending: "install" };
      return state.shown ? state : { ...state, pending: "remind" };
    case "shown":
      return { pending: null, shown: true };
    case "dropped":
      return { ...state, pending: null };
  }
}

/**
 * Keeps TeX Live current from the weekly package check. A tree the writer
 * owns (handed over by an earlier administrator prompt) updates silently, as
 * no password is needed; only a failed silent update falls back to the
 * reminder. Otherwise a toast tells the writer: the Settings badge and the
 * lineno build notice only reach someone already looking there. A TeX Live
 * tree under /usr/local/texlive gets the doctor's one-click update, whose
 * one administrator prompt hands the tree over; any other TeX gets the
 * command, since Lattice does not change it.
 *
 * It never nags: once a launch at most (the check itself runs at most
 * weekly), no sooner than a day after the last one, and "Later" keeps it
 * away for `REMINDER_SNOOZE_MS`. A build running when the check answers
 * holds back the reminder and the silent update until it ends, so neither
 * lands over the build, and an update or a check that finds nothing left
 * takes the reminder down.
 */
export function useTexUpdateReminder(updates: TexPackageUpdates, building: boolean) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reducer, { pending: null, shown: false });
  const followingUpdateRef = useRef(false);
  const updateRef = useLatestRef(updates.update);

  const onChecked = useCallback((report: TexPackageUpdatesReport | null) => {
    if (!report || outdatedCount(report) === 0) return;
    if (report.managed && report.passwordless) dispatch({ type: "found", install: true });
    else if (reminderDue(readReminderRecord(), Date.now())) dispatch({ type: "found", install: false });
  }, []);
  useWeeklyTexPackageCheck(updates.check, onChecked);

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
    if (state.pending === "install") {
      dispatch({ type: "dropped" });
      void updateRef.current().then((failure) => {
        if (failure !== null) dispatch({ type: "found", install: false });
      });
      return;
    }
    writeReminderRecord({ shownAt: Date.now() });
    dispatch({ type: "shown" });
    const later = { label: t`Later`, onClick: () => writeReminderRecord({ snoozedUntil: Date.now() + REMINDER_SNOOZE_MS }) };
    const title = t`Your TeX packages are out of date`;
    if (report.managed) {
      notifyWarning(t`LaTeX setup`, title, {
        detail: report.passwordless
          ? t`Updates available (${count}). Updating can take a few minutes.`
          : t`Updates available (${count}). Updating asks for your password once; after that, Lattice keeps TeX up to date without asking.`,
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
