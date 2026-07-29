import { useEffect, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";
import { CloseButton } from "./components/ui/icon-button";
import { EmptyState } from "./components/ui/empty-state";
import { Button } from "./components/ui/button";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";

export type AppLogLevel = "info" | "success" | "warning" | "error";
export type AppLogEntry = {
  id: string;
  timestamp: string;
  level: AppLogLevel;
  source: string;
  title: string;
  detail: string;
};

const STORAGE_KEY = "lattice.app-log.v1";
const MAX_ENTRIES = 300;
const EMPTY_TOAST_IDS: string[] = [];
let entries: AppLogEntry[] = readEntries();
let visibleToastIds: string[] = [];
const listeners = new Set<() => void>();

function readEntries(): AppLogEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Logging must never prevent the original operation from completing.
  }
}

export function addAppLog(input: {
  level: AppLogLevel;
  source: string;
  title: string;
  detail?: string;
  toast?: boolean;
}): AppLogEntry {
  const entry: AppLogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: input.level,
    source: input.source,
    title: input.title,
    detail: input.detail?.trim() ?? "",
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  if (input.toast !== false) visibleToastIds = [entry.id, ...visibleToastIds].slice(0, 4);
  persist();
  emit();
  return entry;
}

export function clearAppLogs() {
  entries = [];
  visibleToastIds = [];
  persist();
  emit();
}

export function formatAppLogs(value = entries): string {
  return value.map((entry) => [
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.title}`,
    entry.detail,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function dismissToast(id: string) {
  visibleToastIds = visibleToastIds.filter((value) => value !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useLogSnapshot() {
  return useSyncExternalStore(subscribe, () => entries, () => entries);
}

function useToastIdsSnapshot() {
  return useSyncExternalStore(
    subscribe,
    () => visibleToastIds,
    () => EMPTY_TOAST_IDS,
  );
}

const LOG_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: CircleAlert,
};

function AppToast({ entry }: { entry: AppLogEntry }) {
  const Icon = LOG_ICON[entry.level];
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(entry.id), entry.level === "error" ? 9000 : 6000);
    return () => window.clearTimeout(timer);
  }, [entry.id, entry.level]);
  return (
    <div className={`app-toast ${entry.level}`} role={entry.level === "error" ? "alert" : "status"}>
      <Icon size={15} />
      <div><strong>{entry.title}</strong>{entry.detail && <span title={entry.detail}>{entry.detail}</span>}</div>
      <CloseButton
        label="Dismiss notification"
        size="compact"
        onClick={() => dismissToast(entry.id)}
      />
    </div>
  );
}

export function AppToastStack() {
  const toastIds = useToastIdsSnapshot();
  const toasts = toastIds
    .map((id) => entries.find((entry) => entry.id === id))
    .filter(Boolean) as AppLogEntry[];
  return <div className="app-toast-stack">{toasts.map((entry) => <AppToast key={entry.id} entry={entry} />)}</div>;
}

export function AppLogsSettings() {
  const logs = useLogSnapshot();
  const copy = () => void navigator.clipboard.writeText(formatAppLogs(logs));
  return (
    <div className="settings-section app-logs-settings">
      <SettingsSectionHeader
        title="Logs"
        description="Warnings and errors remain here after their notifications are dismissed."
      />
      <div className="app-log-actions">
        <Button size="compact" disabled={logs.length === 0} onClick={copy}>Copy all</Button>
        <Button size="compact" disabled={logs.length === 0} onClick={clearAppLogs}>Clear</Button>
      </div>
      <div className="app-log-list">
        {logs.length === 0 && (
          <EmptyState align="start" density="compact" description="No logs yet." />
        )}
        {logs.map((entry) => {
          const Icon = LOG_ICON[entry.level];
          return (
            <article key={entry.id} className={`app-log-entry ${entry.level}`}>
              <Icon size={14} />
              <div>
                <header><strong>{entry.title}</strong><time>{new Date(entry.timestamp).toLocaleString()}</time></header>
                <small>{entry.source}</small>
                {entry.detail && <pre>{entry.detail}</pre>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
