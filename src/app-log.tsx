import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";
import { CloseButton } from "./components/ui/icon-button";
import { EmptyState } from "./components/ui/empty-state";
import { Button } from "./components/ui/button";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";
import { SettingsGroup } from "./components/ui/settings-row";
import { CopyButton } from "./components/copy-button";
import {
  clearAppLogs,
  dismissAppToast,
  formatAppLogs,
  getAppLogEntry,
  getAppToastOptions,
  useAppLogSnapshot,
  useAppToastIdsSnapshot,
  type AppLogEntry,
} from "./app-log-store";

const LOG_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: CircleAlert,
};

function AppToast({ entry }: { entry: AppLogEntry }) {
  const Icon = LOG_ICON[entry.level];
  const options = getAppToastOptions(entry.id);
  const timeoutMs =
    options?.timeoutMs ?? (entry.level === "error" ? 9_000 : 6_000);
  useEffect(() => {
    if (timeoutMs === 0) return;
    const timer = window.setTimeout(
      () => dismissAppToast(entry.id),
      Math.max(1_000, timeoutMs),
    );
    return () => window.clearTimeout(timer);
  }, [entry.id, timeoutMs]);
  const expanded = Boolean(
    entry.detail.length > 72 ||
    options?.copyText ||
    options?.primaryAction ||
    options?.secondaryAction,
  );
  return (
    <div
      className={`app-toast ${entry.level}${expanded ? " expanded" : ""}`}
      role={entry.level === "error" ? "alert" : "status"}
    >
      <Icon size={15} />
      <div>
        <strong>{entry.title}</strong>
        {entry.detail && <span title={entry.detail}>{entry.detail}</span>}
        {(options?.copyText ||
          options?.primaryAction ||
          options?.secondaryAction) && (
          <div className="app-toast-actions">
            {options.copyText && (
              <CopyButton
                className="app-toast-action"
                text={options.copyText}
                title="Copy notification command"
              >
                Copy
              </CopyButton>
            )}
            {options.primaryAction && (
              <button
                type="button"
                className="app-toast-action"
                onClick={() => void options.primaryAction?.onClick()}
              >
                {options.primaryAction.label}
              </button>
            )}
            {options.secondaryAction && (
              <button
                type="button"
                className="app-toast-action"
                onClick={() => void options.secondaryAction?.onClick()}
              >
                {options.secondaryAction.label}
              </button>
            )}
          </div>
        )}
      </div>
      <CloseButton
        label="Dismiss notification"
        size="compact"
        onClick={() => dismissAppToast(entry.id)}
      />
    </div>
  );
}

export function AppToastStack() {
  const toastIds = useAppToastIdsSnapshot();
  const toasts = toastIds
    .map(getAppLogEntry)
    .filter(Boolean) as AppLogEntry[];
  return <div className="app-toast-stack">{toasts.map((entry) => <AppToast key={entry.id} entry={entry} />)}</div>;
}

export function AppLogsSettings() {
  const logs = useAppLogSnapshot();
  const copy = () => void navigator.clipboard.writeText(formatAppLogs(logs));
  return (
    <div className="settings-section app-logs-settings">
      <SettingsSectionHeader
        title="Logs"
        description="Warnings and errors remain here after their notifications are dismissed."
      />
      <SettingsGroup title="Activity log">
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
      </SettingsGroup>
    </div>
  );
}
