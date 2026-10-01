/**
 * The single entry point for anything the user is told.
 *
 * Every notification in Lattice renders as one surface — the top-right toast
 * stack in `app-log.tsx` — and every notification is recorded, because the only
 * way to raise one is to go through here, and here always writes to the app log
 * (in-app list + rotating `lattice.log` on disk). Notifications that appeared
 * without a log line were the reason support reports could not be traced.
 *
 * Messages that are *not* notifications — a field the user is about to submit,
 * a region explaining why it has no content — belong in `<InlineMessage>`
 * (`components/ui/inline-message.tsx`), not here. The rule:
 *
 *   event  → an action the user started has finished, and the surrounding UI
 *            is still usable → toast, i.e. this module
 *   state  → why a region is empty, or whether a field is valid → inline
 */
import {
  addAppLog,
  dismissAppToastByDedupeKey,
  type AppLogContext,
  type AppLogLevel,
  type AppToastAction,
} from "./app-log-store";
import { msg } from "@lingui/core/macro";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";

export type NotifyOptions = {
  detail?: string;
  /** Text the toast's Copy button puts on the clipboard. Errors get one for free. */
  copyText?: string;
  /** 0 keeps the toast until it is dismissed. Defaults by level in `AppToast`. */
  timeoutMs?: number;
  primaryAction?: AppToastAction;
  secondaryAction?: AppToastAction;
  onDismiss?: () => void;
  /**
   * Overrides the default source-and-title collapsing. Give two notifications
   * the same key to have the later one replace the earlier, or a unique key to
   * opt out of collapsing entirely.
   */
  dedupeKey?: string;
};

type ActionFailureOptions = NotifyOptions & {
  /** Record the failed outcome without adding a second surface beside inline diagnostics. */
  toast?: boolean;
};

/** Composite map keys, joined on a separator no message can contain. */
function toastKey(...parts: string[]): string {
  return parts.join("\u0000");
}

function notify(level: AppLogLevel, source: string, title: string, options: ActionFailureOptions = {}, context?: AppLogContext) {
  const detail = options.detail?.trim() ?? "";
  // The banner this replaced always offered Copy on failures, and an error you
  // cannot paste into a bug report is half a report.
  const copyText = options.copyText ?? (level === "error" ? [title, detail].filter(Boolean).join("\n") : undefined);
  // A toast shows one line of a failure; its Copy button often carries far more
  // — a whole LaTeX log, a command, a stack. Anything the user can copy has to
  // be in the log too, or "paste this into the report" and "send me the log"
  // return different stories about the same failure. Logged first and without a
  // toast of its own, so it reads just before the notification it belongs to.
  if (copyText && !`${title}\n${detail}`.includes(copyText)) {
    const progress = context && { ...context, phase: "progress" as const, outcome: undefined, duration_ms: undefined };
    const fullTextTitle = i18n._(msg`${title} — full text`);
    addAppLog({ level, source, title: fullTextTitle, detail: copyText, context: progress, toast: false });
  }
  const { toast, dedupeKey = toastKey(source, title), detail: _detail, ...toastOptions } = { ...options, copyText };
  return addAppLog({ level, source, title, detail, context, toast, dedupeKey, toastOptions }).id;
}

const notifier = (level: AppLogLevel) => (source: string, title: string, options?: NotifyOptions) =>
  notify(level, source, title, options);
export const notifyError = notifier("error");
export const notifyWarning = notifier("warning");
export const notifySuccess = notifier("success");
export const notifyInfo = notifier("info");

/** A brief "it's on the clipboard" for copies that have nothing else to show for themselves. */
export function notifyCopied(title: string) {
  notifyInfo(i18n._(msg`Clipboard`), title, { timeoutMs: 1_800, dedupeKey: "clipboard-copied" });
}

export type ActionLog = {
  /** Full correlation id; only the legacy text tag is shortened for readability. */
  id: string;
  /** A log-only breadcrumb — no toast. Use for steps worth seeing in a trace. */
  note: (message: string, detail?: string) => void;
  ok: (title: string, options?: NotifyOptions) => void;
  fail: (reason: unknown, options?: ActionFailureOptions) => void;
  /** Enrich the terminal event with domain counts/flags, without raw content. */
  enrich: (metrics: NonNullable<AppLogContext["metrics"]>) => void;
  /** Log-only terminal outcome; safe to call from finally as a cancellation fallback. */
  finish: (outcome: NonNullable<AppLogContext["outcome"]>, title?: string) => void;
  /**
   * Retract this action's outstanding toast. A retry that succeeds should not
   * leave the previous failure on screen waiting out its timeout.
   */
  clear: () => void;
};

function tagged(id: string, detail?: string): string {
  return [detail?.trim(), `#${id.replace(/-/g, "").slice(0, 6)}`].filter(Boolean).join("\n");
}

/**
 * Open a correlated trace for one user-initiated operation.
 *
 * The start is a crash breadcrumb; ok/fail raise a toast unless suppressed.
 * Every terminal event carries the initial context, accumulated counts, and
 * elapsed time. Use finish in finally for exits that did not reach ok/fail.
 * `source` and `action` are translated display text; `operation` is the
 * stable id recorded in the context (and allowlisted by the safe log export),
 * so it must not follow the interface language.
 */
export function logAction(source: string, action: string, detail?: string, operation = action): ActionLog {
  const id = crypto.randomUUID();
  const started = performance.now();
  let completed = false;
  let metrics: NonNullable<AppLogContext["metrics"]> = {};
  const context = (phase: AppLogContext["phase"]): AppLogContext => ({
    operation_id: id,
    operation,
    phase,
    trigger: detail,
    metrics: { ...metrics },
  });
  const terminal = (outcome: NonNullable<AppLogContext["outcome"]>): AppLogContext => ({
    ...context("completed"),
    outcome,
    duration_ms: Math.round(performance.now() - started),
  });
  // Successive runs of the same action share a key, so the newer outcome
  // replaces the older toast; the correlation id is what separates the runs in
  // the log.
  const outcomeKey = toastKey(source, action);
  const logOnly = (level: AppLogLevel, title: string, entryDetail: string, entryContext: AppLogContext) =>
    addAppLog({ level, source, title, detail: entryDetail, context: entryContext, toast: false });
  logOnly("info", `▶ ${action}`, tagged(id, detail), context("started"));
  return {
    id,
    enrich: (values) => { metrics = { ...metrics, ...values }; },
    finish: (outcome, title) => {
      if (completed) return;
      completed = true;
      const level = outcome === "error" ? "error" : outcome === "success" ? "success" : "info";
      const outcomeTitle = outcome === "error" ? i18n._(msg`${action} error`)
        : outcome === "success" ? i18n._(msg`${action} success`)
          : i18n._(msg`${action} cancelled`);
      logOnly(level, title ?? outcomeTitle, tagged(id), terminal(outcome));
    },
    note: (message, noteDetail) => { logOnly("info", message, tagged(id, noteDetail), context("progress")); },
    ok: (title, options) => {
      if (completed) return;
      completed = true;
      notify("success", source, title, {
        ...options,
        detail: tagged(id, options?.detail),
        dedupeKey: options?.dedupeKey ?? outcomeKey,
      }, terminal("success"));
    },
    fail: (reason, options) => {
      if (completed) return;
      completed = true;
      const message = toMessage(reason);
      const failedTitle = i18n._(msg`${action} failed`);
      notify("error", source, failedTitle, {
        ...options,
        detail: tagged(id, options?.detail ?? message),
        copyText: options?.copyText ?? `${failedTitle}\n${message}`,
        dedupeKey: options?.dedupeKey ?? outcomeKey,
      // eslint-disable-next-line lingui/no-unlocalized-strings -- error_type is a JavaScript error class name
      }, { ...terminal("error"), error_type: reason instanceof Error ? reason.name : "Error" });
    },
    clear: () => dismissAppToastByDedupeKey(outcomeKey),
  };
}
