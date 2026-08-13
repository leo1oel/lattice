import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, CircleAlert, FolderOpen, Info } from "lucide-react";
import { CloseButton } from "./components/ui/icon-button";
import { EmptyState } from "./components/ui/empty-state";
import { Button } from "./components/ui/button";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";
import { SettingsGroup } from "./components/ui/settings-row";
import { ScrollArea } from "./components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
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
  type AppLogLevel,
} from "./app-log-store";

// One silhouette for every level: a warning triangle among three circles was
// the only thing breaking the stack's rhythm, and severity already reads from
// the status colour. Warning and error share the glyph on purpose.
const LOG_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: CircleAlert,
  error: CircleAlert,
};

/** Correlation ids belong in the app log, not in user-facing notification copy. */
function visibleToastDetail(detail: string): string {
  return detail.replace(/(?:^|\n)#[0-9a-f]{6}$/i, "").trim();
}

function AppToast({ entry }: { entry: AppLogEntry }) {
  const Icon = LOG_ICON[entry.level];
  const options = getAppToastOptions(entry.id);
  const detail = visibleToastDetail(entry.detail);
  const timeoutMs =
    options?.timeoutMs ?? (entry.level === "error" ? 9_000 : 6_000);
  useEffect(() => {
    if (timeoutMs === 0) return;
    const timer = window.setTimeout(
      () => dismissAppToast(entry.id),
      Math.max(1_000, timeoutMs),
    );
    return () => window.clearTimeout(timer);
    // entry.timestamp: a deduped repeat refreshes the entry in place (same id),
    // and the toast should stay visible for a full window after the refresh.
  }, [entry.id, entry.timestamp, timeoutMs]);
  // Messages migrated off the old one-line banners arrive as a title with no
  // detail, so length has to be judged across both — a 200-character title
  // clipped to one line is the failure this replaced.
  const expanded = Boolean(
    detail.length > 72 ||
    entry.title.length > 72 ||
    options?.copyText ||
    options?.primaryAction ||
    options?.secondaryAction,
  );
  return (
    <div
      className={`app-toast ${entry.level}${expanded ? " expanded" : ""}`}
      role={entry.level === "error" ? "alert" : "status"}
      data-app-toast=""
      // Notifications arrive while someone is writing. Taking the caret out of
      // the editor to dismiss one — and losing the selection with it — is worse
      // than the interruption itself, so the whole card refuses focus on press
      // and lets the click through to the button underneath.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Icon size={15} />
      <div>
        <strong>{entry.title}</strong>
        {detail && <span title={detail}>{detail}</span>}
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
  const [levelFilter, setLevelFilter] = useState<"all" | AppLogLevel>("all");
  const [logDir, setLogDir] = useState<string | null>(null);
  const logViewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    invoke<string>("get_app_log_dir")
      .then(setLogDir)
      .catch(() => setLogDir(null));
  }, []);
  const visible = levelFilter === "all" ? logs : logs.filter((entry) => entry.level === levelFilter);
  // Entries are stored newest-first; the text view reads like a terminal —
  // chronological, newest at the bottom. The panel fills the settings
  // viewport (the page itself never scrolls) and scrolls internally with
  // the app's own scrollbar.
  const logText = formatAppLogs([...visible].reverse());
  useEffect(() => {
    const panel = logViewportRef.current;
    if (!panel) return;
    const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
    if (nearBottom) panel.scrollTop = panel.scrollHeight;
  }, [logText]);
  const copy = () => void navigator.clipboard.writeText(logText);
  const openLogFolder = () => {
    if (!logDir) return;
    // Keep arbitrary filesystem paths out of the WebView's opener authority.
    // The backend resolves and opens only Lattice's own log directory.
    void invoke("open_app_log_dir");
  };
  return (
    <div className="settings-section app-logs-settings">
      <SettingsSectionHeader
        title="Logs"
        description="Newest last, like a terminal. This view keeps the most recent 300 entries; the full history lives in a rotating log file on disk, which Clear does not remove."
      />
      <SettingsGroup title="Activity log">
        <div className="app-log-actions">
          <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value as "all" | AppLogLevel)}>
            <SelectTrigger size="form" aria-label="Log level filter"><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="start">
              <SelectItem value="all">All levels</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Button size="compact" disabled={visible.length === 0} onClick={copy}>Copy all</Button>
          <Button size="compact" disabled={logs.length === 0} onClick={clearAppLogs}>Clear</Button>
          <Button size="compact" disabled={!logDir} onClick={openLogFolder}>
            <FolderOpen size={13} />
            Open log folder
          </Button>
        </div>
        {logDir && <p className="app-log-location">{logDir}</p>}
        {visible.length === 0 ? (
          <EmptyState align="start" density="compact" description={logs.length === 0 ? "No logs yet." : "No logs at this level."} />
        ) : (
          <ScrollArea className="app-log-scroll" viewportRef={logViewportRef} fadeEdges={false}>
            <pre className="app-log-text">{logText}</pre>
          </ScrollArea>
        )}
      </SettingsGroup>
    </div>
  );
}
