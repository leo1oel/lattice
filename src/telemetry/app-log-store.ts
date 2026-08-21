import { useSyncExternalStore } from "react";

export type AppLogLevel = "info" | "success" | "warning" | "error";
export type AppLogEntry = {
  id: string;
  timestamp: string;
  level: AppLogLevel;
  source: string;
  title: string;
  detail: string;
};

export type AppToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
};

export type AppToastOptions = {
  copyText?: string;
  timeoutMs?: number;
  primaryAction?: AppToastAction;
  secondaryAction?: AppToastAction;
  onDismiss?: () => void;
};

/**
 * Everything one on-screen toast draws, in a single subscribed value.
 *
 * The options used to be looked up from the module map during render while the
 * text came from the subscribed entry. Nothing invalidates a plain map read, so
 * an aggressively memoized toast — `app-log.tsx` compiles with zero React
 * Compiler bailouts, so this ships — kept the id, adopted the new title, and
 * re-rendered the old buttons: "Could not update Pi" over Cancel where the
 * caller had asked for Retry. Options are not serializable (they carry click
 * handlers), so they cannot live on `AppLogEntry`, which is persisted; pairing
 * them here keeps them out of storage and still inside the subscription.
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

function readEntries(): AppLogEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, MAX_ENTRIES) : [];
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
  const unchanged =
    next.length === visibleToasts.length &&
    next.every((toast, index) =>
      toast.entry === visibleToasts[index].entry &&
      toast.options === visibleToasts[index].options);
  if (!unchanged) visibleToasts = next;
}

function emit() {
  syncVisibleToasts();
  for (const listener of listeners) listener();
}

let persistWarningIssued = false;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Logging must never prevent the original operation from completing, but a
    // silent failure here is how the history used to vanish — surface it once.
    if (persistWarningIssued) return;
    persistWarningIssued = true;
    // Defer so this entry is added after the current mutation finishes; its
    // own persist() failure is suppressed by the flag above.
    queueMicrotask(() =>
      addAppLog({
        level: "warning",
        source: "App",
        title: "Log history can't be saved",
        detail:
          "Browser storage is full or unavailable. New entries still reach the log file on disk, but this list may be lost on restart.",
        toast: false,
      }),
    );
  }
}

// Durable on-disk log (tauri-plugin-log → app_log_dir/lattice.log). Entries are
// forwarded through a serialized, never-rejecting queue so callers stay
// synchronous and concurrent writes keep their order on disk.
let forwardChain: Promise<void> = Promise.resolve();
let forwardDisabled = false;

function forwardToFileLog(entry: AppLogEntry): void {
  if (forwardDisabled) return;
  const line = `[${entry.source}] ${entry.title}${entry.detail ? `\n${entry.detail}` : ""}`;
  forwardChain = forwardChain.then(async () => {
    try {
      const fileLog = await import("@tauri-apps/plugin-log");
      const write =
        entry.level === "error" ? fileLog.error
        : entry.level === "warning" ? fileLog.warn
        : fileLog.info;
      await write(line);
    } catch (reason) {
      // Disable BEFORE reporting: a wrapped console.error → addAppLog →
      // forward → fail loop is the failure mode this prevents.
      forwardDisabled = true;
      // Served as a plain website there is no on-disk log by design, so stay
      // quiet instead of reporting the expected web-bridge rejection.
      if (isWebBridgeUnavailable(reason)) return;
      try {
        console.error("Lattice file logging unavailable", reason);
      } catch {
        // Nothing left to report through.
      }
    }
  });
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
      const updated = updateAppLog(
        existingId,
        {
          level: input.level,
          source: input.source,
          title: input.title,
          detail: input.detail?.trim() ?? "",
        },
        input.toastOptions,
      );
      if (updated) return updated;
    }
  }
  const entry: AppLogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: input.level,
    source: input.source,
    title: input.title,
    detail: input.detail?.trim().slice(0, MAX_DETAIL_LENGTH) ?? "",
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
  persist();
  emit();
  forwardToFileLog(entry);
  return entry;
}

export function updateAppLog(
  id: string,
  patch: Partial<Pick<AppLogEntry, "level" | "source" | "title" | "detail">>,
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
    detail: (patch.detail ?? current.detail).slice(0, MAX_DETAIL_LENGTH),
  };
  entries = [updated, ...entries.filter((entry) => entry.id !== id)].slice(0, MAX_ENTRIES);
  visibleToastIds = [id, ...visibleToastIds.filter((value) => value !== id)].slice(0, 4);
  if (toastOptions) toastOptionsById.set(id, toastOptions);
  persist();
  emit();
  forwardToFileLog(updated);
  return updated;
}

export function clearAppLogs() {
  entries = [];
  visibleToastIds = [];
  toastOptionsById.clear();
  entryIdByDedupeKey.clear();
  dedupeKeyByEntryId.clear();
  persist();
  emit();
}

export function formatAppLogs(value = entries): string {
  return value.map((entry) => [
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.title}`,
    entry.detail,
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
  emit();
  if (notify) options?.onDismiss?.();
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
