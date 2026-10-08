import { useSyncExternalStore } from "react";
import { msg } from "@lingui/core/macro";
import { version } from "../../package.json";
import { AppLogFileQueue, type LogLosses } from "./app-log-file-queue";
import { translateOr } from "./early-i18n";
import { playInterfaceSound } from "./interface-sounds";

export type AppLogContext = {
  operation_id: string;
  request_id?: string;
  parent_request_id?: string;
  operation: string;
  phase: "started" | "progress" | "completed";
  outcome?: "success" | "error" | "cancelled";
  duration_ms?: number;
  trigger?: string;
  error_type?: string;
  /** Counts and flags only; never pass document contents or credentials here. */
  metrics?: Record<string, number | boolean>;
};

export type AppLogLevel = "info" | "success" | "warning" | "error";
export type AppLogEntry = {
  id: string;
  timestamp: string;
  level: AppLogLevel;
  source: string;
  title: string;
  detail: string;
  context?: AppLogContext;
};

export type AppToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
  /** An action dismisses its toast once it runs, unless the toast still has a choice left to offer. */
  keepOpen?: boolean;
};

/**
 * How far along the operation a toast reports is: a fraction from 0 to 1, or
 * `"indeterminate"` while it cannot say. A toast with progress stays up until
 * the operation settles it.
 */
export type AppToastProgress = number | "indeterminate";

export type AppToastOptions = {
  copyText?: string;
  timeoutMs?: number;
  progress?: AppToastProgress;
  primaryAction?: AppToastAction;
  secondaryAction?: AppToastAction;
  onDismiss?: () => void;
};

/**
 * Everything one on-screen toast draws, in a single subscribed value.
 *
 * Nothing invalidates a plain module-map read during render, so a memoized
 * toast (`toast-stack.tsx` compiles with zero React Compiler bailouts) would keep
 * its old buttons under a new title. Options carry click handlers, so they
 * cannot live on the persisted `AppLogEntry`; pairing them here keeps them out
 * of storage and still inside the subscription.
 */
export type AppToastView = {
  entry: AppLogEntry;
  options?: AppToastOptions;
};

const STORAGE_KEY = "lattice.app-log.v1";
const MAX_ENTRIES = 300;
const MAX_DETAIL_LENGTH = 4_000;
const EMPTY_TOASTS: readonly AppToastView[] = [];
const listeners = new Set<() => void>();
const toastOptionsById = new Map<string, AppToastOptions>();
// Dedupe bookkeeping, live only while a toast is on screen. Both directions are
// kept so a dismissal can drop the key without scanning the map.
const entryIdByDedupeKey = new Map<string, string>();
const dedupeKeyByEntryId = new Map<string, string>();

// Defense in depth for diagnostic strings, not a guarantee that arbitrary
// document output is safe to share. Preserve local paths/compiler diagnostics;
// remove common credential forms before persistence, forwarding, and export.
export function redactLogText(value: string): string {
  /* eslint-disable lingui/no-unlocalized-strings -- redaction marker, part of the log format */
  return value
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:["']?)(?:authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|ticket|password|secret)["']?\s*[:=]\s*["']?)[^\s&"',;}]+/gi, "$1[redacted]")
    .replace(/(\/binary\/(?:uploads|downloads)\/)[^\s/?#"']+/gi, "$1[redacted]");
  /* eslint-enable lingui/no-unlocalized-strings */
}

/** Correlation ids belong in the app log, not in user-facing notification copy. */
export function visibleToastDetail(detail: string): string {
  return detail.replace(/(?:^|\n)#[0-9a-f]{6}$/i, "").trim();
}

function sanitizeContext(context?: AppLogContext): AppLogContext | undefined {
  return context ? {
    ...context,
    operation: redactLogText(context.operation),
    trigger: context.trigger ? redactLogText(context.trigger).slice(0, MAX_DETAIL_LENGTH) : undefined,
    error_type: context.error_type ? redactLogText(context.error_type) : undefined,
    metrics: context.metrics ? { ...context.metrics } : undefined,
  } : undefined;
}

function readEntries(): AppLogEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, MAX_ENTRIES).flatMap((entry) => {
      if (!entry || typeof entry !== "object"
        || !["id", "timestamp", "source", "title", "detail"].every((key) => typeof entry[key] === "string")
        || !["info", "success", "warning", "error"].includes(entry.level)) return [];
      try {
        const context = entry.context;
        return [{ ...entry,
          source: redactLogText(entry.source), title: redactLogText(entry.title),
          detail: redactLogText(entry.detail).slice(0, MAX_DETAIL_LENGTH),
          context: context && typeof context.operation_id === "string" && typeof context.operation === "string"
            && ["started", "progress", "completed"].includes(context.phase) ? sanitizeContext(context) : undefined,
        }];
      } catch {
        // A malformed legacy record must not discard the remaining history.
        return [];
      }
    }) : [];
  } catch {
    return [];
  }
}

let entries: AppLogEntry[] = readEntries();
let visibleToastIds: string[] = [];
let visibleToasts: readonly AppToastView[] = EMPTY_TOASTS;

/**
 * Re-pair the visible ids with their entry and options.
 *
 * Reused unchanged when nothing a toast draws moved: `useSyncExternalStore`
 * compares snapshots by identity, and a `toast: false` entry emits too — a new
 * array there would re-render the whole stack for a log line nobody sees.
 */
function syncVisibleToasts() {
  const next: AppToastView[] = [];
  for (const id of visibleToastIds) {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry) next.push({ entry, options: toastOptionsById.get(id) });
  }
  const unchanged = next.length === visibleToasts.length && next.every((toast, index) =>
    toast.entry === visibleToasts[index].entry && toast.options === visibleToasts[index].options);
  if (!unchanged) visibleToasts = next;
}

function emitChange() {
  syncVisibleToasts();
  for (const listener of listeners) listener();
}

let persistWarningIssued = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersistence() {
  // Coalesce a burst without postponing persistence indefinitely. In-memory
  // subscribers and disk delivery remain immediate; only the snapshot waits.
  persistTimer ??= setTimeout(flushPersistence, 100);
}

function flushPersistence() {
  if (persistTimer === undefined) return;
  clearTimeout(persistTimer);
  persistTimer = undefined;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Logging must never prevent the original operation from completing, but a
    // silent failure here is how the history used to vanish — surface it once.
    if (persistWarningIssued) return;
    persistWarningIssued = true;
    // Defer so this entry is added after the current mutation finishes; its
    // own persistence failure is suppressed by the flag above.
    /* eslint-disable lingui/no-unlocalized-strings -- English until a catalog is active */
    queueMicrotask(() => addAppLog({
      level: "warning",
      source: translateOr(msg`App`, "App"),
      title: translateOr(msg`Log history can't be saved`, "Log history can't be saved"),
      detail: translateOr(
        msg`Browser storage is full or unavailable. New entries still reach the log file on disk, but this list may be lost on restart.`,
        "Browser storage is full or unavailable. New entries still reach the log file on disk, but this list may be lost on restart.",
      ),
      toast: false,
    }));
    /* eslint-enable lingui/no-unlocalized-strings */
  }
}

// Browser lifecycle events are best effort, not a crash/disk flush guarantee.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersistence);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistence();
  });
}

const sessionId = crypto.randomUUID();
const lossEntryId = crypto.randomUUID();
let pendingLossEntry: AppLogEntry | undefined;

function serializeFileEntry(entry: AppLogEntry): string {
  // The plugin may add its own prefix; the message itself is single-line JSON.
  // Keep the original event time, even when IPC delivery is delayed.
  const event = entry.context ? "app.operation" : "app.notification";
  return JSON.stringify({ schema_version: 1, event, service: "lattice.frontend", version, session_id: sessionId, ...entry });
}

function reportFileLoss(losses: LogLosses): string {
  const entry: AppLogEntry = {
    id: lossEntryId, timestamp: new Date().toISOString(), level: "warning",
    source: "logging", title: "logging.delivery.loss", detail: "",
    context: {
      operation_id: sessionId, operation: "logging.delivery", phase: "progress",
      metrics: { dropped_overflow: losses.overflow, dropped_failed: losses.failed },
    },
  };
  // One history update per burst: a later loss replaces the pending summary.
  if (!pendingLossEntry) {
    queueMicrotask(() => {
      if (!pendingLossEntry) return;
      entries = [pendingLossEntry, ...entries.filter((item) => item.id !== lossEntryId)].slice(0, MAX_ENTRIES);
      pendingLossEntry = undefined;
      schedulePersistence();
      emitChange();
    });
  }
  pendingLossEntry = entry;
  // Deliberately bypass addAppLog/console capture: sink failures must never
  // enqueue more sink failures. The queue writes this summary after recovery.
  return serializeFileEntry(entry);
}

const fileQueue = new AppLogFileQueue(async (line, priority) => {
  const fileLog = await import("@tauri-apps/plugin-log");
  await (priority === 2 ? fileLog.error : priority === 1 ? fileLog.warn : fileLog.info)(line);
}, reportFileLoss);

/**
 * One structured line straight to lattice.log, with no in-app entry or toast:
 * the channel `wide-event.ts` writes through. Same queue and loss accounting
 * as everything else the log file gets from the frontend.
 */
export function writeLogFileLine(line: string, level: "info" | "warning"): void {
  fileQueue.enqueue(line, level === "warning" ? 1 : 0);
}

function forwardToFileLog(entry: AppLogEntry): void {
  fileQueue.enqueue(serializeFileEntry(entry), entry.level === "error" ? 2 : entry.level === "warning" ? 1 : 0);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addAppLog(input: {
  level: AppLogLevel;
  source: string;
  title: string;
  detail?: string;
  context?: AppLogContext;
  toast?: boolean;
  toastOptions?: AppToastOptions;
  /**
   * Collapse a repeat of a notification that is still on screen into the toast
   * already showing it, instead of pushing a second copy. Four identical build
   * failures would otherwise fill the entire visible stack. The on-disk log
   * still records every occurrence — `updateAppLog` forwards too.
   */
  dedupeKey?: string;
}): AppLogEntry {
  if (input.dedupeKey) {
    const existingId = entryIdByDedupeKey.get(input.dedupeKey);
    if (existingId && visibleToastIds.includes(existingId)) {
      const previous = entries.find((entry) => entry.id === existingId);
      if (input.context?.operation_id && previous?.context?.operation_id !== input.context.operation_id) {
        // Collapse the visible toast, not the history of distinct operations.
        dismissAppToast(existingId, false);
      } else {
        const { level, source, title, context } = input;
        const updated = updateAppLog(existingId, { level, source, title, detail: input.detail?.trim() ?? "", context }, input.toastOptions);
        if (updated) return updated;
      }
    }
  }
  const entry: AppLogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: input.level,
    source: redactLogText(input.source),
    title: redactLogText(input.title),
    detail: redactLogText(input.detail?.trim() ?? "").slice(0, MAX_DETAIL_LENGTH),
    context: sanitizeContext(input.context),
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  if (input.toast !== false) {
    visibleToastIds = [entry.id, ...visibleToastIds].slice(0, 4);
    if (input.toastOptions) toastOptionsById.set(entry.id, input.toastOptions);
    if (input.dedupeKey) {
      entryIdByDedupeKey.set(input.dedupeKey, entry.id);
      dedupeKeyByEntryId.set(entry.id, input.dedupeKey);
    }
  }
  schedulePersistence();
  emitChange();
  forwardToFileLog(entry);
  return entry;
}

export function updateAppLog(
  id: string,
  patch: Partial<Pick<AppLogEntry, "level" | "source" | "title" | "detail" | "context">>,
  toastOptions?: AppToastOptions,
): AppLogEntry | null {
  const current = entries.find((entry) => entry.id === id);
  if (!current) return null;
  // The entry jumps back to the front of a newest-first list, so its timestamp
  // has to move with it — otherwise the terminal-style log view reads
  // out of order.
  const updated = {
    ...current,
    ...patch,
    timestamp: new Date().toISOString(),
    source: redactLogText(patch.source ?? current.source),
    title: redactLogText(patch.title ?? current.title),
    detail: redactLogText(patch.detail ?? current.detail).slice(0, MAX_DETAIL_LENGTH),
    context: sanitizeContext("context" in patch ? patch.context : current.context),
  };
  entries = [updated, ...entries.filter((entry) => entry.id !== id)].slice(0, MAX_ENTRIES);
  visibleToastIds = [id, ...visibleToastIds.filter((value) => value !== id)].slice(0, 4);
  if (toastOptions) {
    // An operation the writer watched run to its end is the one moment a toast
    // speaks: routine notifications stay silent (interface-sounds.ts), but a
    // progress toast settling into success or failure gets the matching cue.
    const wasRunning = toastOptionsById.get(id)?.progress !== undefined;
    if (wasRunning && toastOptions.progress === undefined && (updated.level === "success" || updated.level === "error")) {
      playInterfaceSound(updated.level);
    }
    toastOptionsById.set(id, toastOptions);
  }
  schedulePersistence();
  emitChange();
  forwardToFileLog(updated);
  return updated;
}

export function clearAppLogs() {
  entries = [];
  visibleToastIds = [];
  toastOptionsById.clear();
  entryIdByDedupeKey.clear();
  dedupeKeyByEntryId.clear();
  schedulePersistence();
  flushPersistence();
  emitChange();
}

export function formatAppLogs(value = entries): string {
  return value.map((entry) => [
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.title}`,
    entry.detail,
    entry.context ? JSON.stringify(entry.context) : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}

export function dismissAppToast(id: string, notify = true) {
  const options = toastOptionsById.get(id);
  visibleToastIds = visibleToastIds.filter((value) => value !== id);
  toastOptionsById.delete(id);
  const dedupeKey = dedupeKeyByEntryId.get(id);
  if (dedupeKey) {
    dedupeKeyByEntryId.delete(id);
    // Only if it still points here: a later toast may already own the key.
    if (entryIdByDedupeKey.get(dedupeKey) === id) entryIdByDedupeKey.delete(dedupeKey);
  }
  emitChange();
  if (notify) options?.onDismiss?.();
}

/**
 * Move the progress of the toast showing under `key`, without a log line.
 *
 * A download reports hundreds of chunks; each is a redraw of the bar, not an
 * event worth a row in the log. The phase changes around it (started,
 * installing, failed) still go through `addAppLog`/`updateAppLog`.
 */
export function updateAppToastProgress(key: string, progress: AppToastProgress) {
  const id = entryIdByDedupeKey.get(key);
  const options = id ? toastOptionsById.get(id) : undefined;
  if (!id || !options || options.progress === progress) return;
  toastOptionsById.set(id, { ...options, progress });
  emitChange();
}

/**
 * Take down whatever toast is currently showing under `key`, if any.
 *
 * This is how an operation retracts its own earlier failure: a build that
 * succeeds should not leave the previous "compilation failed" toast sitting on
 * screen waiting out its timeout.
 */
export function dismissAppToastByDedupeKey(key: string) {
  const id = entryIdByDedupeKey.get(key);
  if (id) dismissAppToast(id, false);
}

export function getAppLogEntry(id: string): AppLogEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

export function getAppToastOptions(id: string): AppToastOptions | undefined {
  return toastOptionsById.get(id);
}

/**
 * Which entries are currently on screen, as opposed to only in the log. The
 * two are deliberately different sets — `toast: false` records something
 * without interrupting anyone — and this is how that difference is checked
 * outside React.
 */
export function getVisibleAppToastIds(): readonly string[] {
  return visibleToastIds;
}

export function useAppLogSnapshot(): AppLogEntry[] {
  return useSyncExternalStore(subscribe, () => entries, () => entries);
}

export function useAppToastsSnapshot(): readonly AppToastView[] {
  return useSyncExternalStore(
    subscribe,
    () => visibleToasts,
    () => EMPTY_TOASTS,
  );
}
