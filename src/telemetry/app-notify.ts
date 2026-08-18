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
  type AppLogLevel,
  type AppToastAction,
} from "./app-log-store";
import { toMessage } from "../app-utils";

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

/** Composite map keys, joined on a separator no message can contain. */
function toastKey(...parts: string[]): string {
  return parts.join("\u0000");
}

function notify(
  level: AppLogLevel,
  source: string,
  title: string,
  options: NotifyOptions = {},
): string {
  const detail = options.detail?.trim() ?? "";
  // The banner this replaced always offered Copy on failures, and an error you
  // cannot paste into a bug report is half a report.
  const copyText =
    options.copyText
    ?? (level === "error" ? [title, detail].filter(Boolean).join("\n") : undefined);
  // A toast shows one line of a failure; its Copy button often carries far more
  // — a whole LaTeX log, a command, a stack. Anything the user can copy has to
  // be in the log too, or "paste this into the report" and "send me the log"
  // return different stories about the same failure. Logged first and without a
  // toast of its own, so it reads just before the notification it belongs to.
  if (copyText && !`${title}\n${detail}`.includes(copyText)) {
    addAppLog({
      level,
      source,
      title: `${title} — full text`,
      detail: copyText,
      toast: false,
    });
  }
  return addAppLog({
    level,
    source,
    title,
    detail,
    toast: true,
    dedupeKey: options.dedupeKey ?? toastKey(source, title),
    toastOptions: {
      ...(copyText ? { copyText } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.primaryAction ? { primaryAction: options.primaryAction } : {}),
      ...(options.secondaryAction ? { secondaryAction: options.secondaryAction } : {}),
      ...(options.onDismiss ? { onDismiss: options.onDismiss } : {}),
    },
  }).id;
}

export const notifyError = (source: string, title: string, options?: NotifyOptions) =>
  notify("error", source, title, options);
export const notifyWarning = (source: string, title: string, options?: NotifyOptions) =>
  notify("warning", source, title, options);
export const notifySuccess = (source: string, title: string, options?: NotifyOptions) =>
  notify("success", source, title, options);
export const notifyInfo = (source: string, title: string, options?: NotifyOptions) =>
  notify("info", source, title, options);

export type ActionLog = {
  /** Short correlation id shared by this action's start, notes, and outcome. */
  id: string;
  /** A log-only breadcrumb — no toast. Use for steps worth seeing in a trace. */
  note: (message: string, detail?: string) => void;
  ok: (title: string, options?: NotifyOptions) => void;
  fail: (reason: unknown, options?: NotifyOptions) => void;
  /**
   * Retract this action's outstanding toast. A retry that succeeds should not
   * leave the previous failure on screen waiting out its timeout.
   */
  clear: () => void;
};

function correlationId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

function tagged(id: string, detail?: string): string {
  return [detail?.trim(), `#${id}`].filter(Boolean).join("\n");
}

/**
 * Open a correlated trace for one user-initiated operation.
 *
 * The start is logged without a toast; the outcome raises one. Both carry the
 * same `#id`, so a log read back weeks later shows which action produced which
 * failure rather than a bare error floating on its own.
 */
export function logAction(source: string, action: string, detail?: string): ActionLog {
  const id = correlationId();
  // Successive runs of the same action share a key, so the newer outcome
  // replaces the older toast; the correlation id is what separates the runs in
  // the log.
  const outcomeKey = toastKey(source, action);
  addAppLog({
    level: "info",
    source,
    title: `▶ ${action}`,
    detail: tagged(id, detail),
    toast: false,
  });
  return {
    id,
    note: (message, noteDetail) => {
      addAppLog({
        level: "info",
        source,
        title: message,
        detail: tagged(id, noteDetail),
        toast: false,
      });
    },
    ok: (title, options) => {
      notify("success", source, title, {
        ...options,
        detail: tagged(id, options?.detail),
        dedupeKey: options?.dedupeKey ?? outcomeKey,
      });
    },
    fail: (reason, options) => {
      const message = toMessage(reason);
      notify("error", source, `${action} failed`, {
        ...options,
        detail: tagged(id, options?.detail ?? message),
        copyText: options?.copyText ?? `${action} failed\n${message}`,
        dedupeKey: options?.dedupeKey ?? outcomeKey,
      });
    },
    clear: () => dismissAppToastByDedupeKey(outcomeKey),
  };
}
