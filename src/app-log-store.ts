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

const STORAGE_KEY = "lattice.app-log.v1";
const MAX_ENTRIES = 300;
const MAX_DETAIL_LENGTH = 4_000;
const EMPTY_TOAST_IDS: string[] = [];
const listeners = new Set<() => void>();
const toastOptionsById = new Map<string, AppToastOptions>();

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

function emit() {
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
}): AppLogEntry {
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
  const updated = { ...current, ...patch, detail: (patch.detail ?? current.detail).slice(0, MAX_DETAIL_LENGTH) };
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
  emit();
  if (notify) options?.onDismiss?.();
}

export function getAppLogEntry(id: string): AppLogEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

export function getAppToastOptions(id: string): AppToastOptions | undefined {
  return toastOptionsById.get(id);
}

export function useAppLogSnapshot(): AppLogEntry[] {
  return useSyncExternalStore(subscribe, () => entries, () => entries);
}

export function useAppToastIdsSnapshot(): string[] {
  return useSyncExternalStore(
    subscribe,
    () => visibleToastIds,
    () => EMPTY_TOAST_IDS,
  );
}
