import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, ChevronRight, CircleAlert, Download, FolderOpen, Info } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { CloseButton } from "../components/ui/icon-button";
import { EmptyState } from "../components/ui/empty-state";
import { Button } from "../components/ui/button";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup } from "../components/ui/settings-row";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { CopyButton } from "../components/copy-button";
import { ModalDialog } from "../components/ui/modal-dialog";
import { CheckboxField } from "../components/ui/checkbox-field";
import { serializeAppLogExport } from "./app-log-export";
import {
  clearAppLogs,
  dismissAppToast,
  formatAppLogs,
  useAppLogSnapshot,
  useAppToastsSnapshot,
  type AppLogEntry,
  type AppLogLevel,
  type AppToastOptions,
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

function LogEntryRow({ entry, onOperationFilter }: { entry: AppLogEntry; onOperationFilter: (id: string) => void }) {
  const { t } = useLingui();
  const Icon = LOG_ICON[entry.level] ?? Info;
  const date = new Date(entry.timestamp);
  const displayTime = Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString();
  const detail = entry.context ? visibleToastDetail(entry.detail) : entry.detail;
  const levels = { info: t`Info`, success: t`Success`, warning: t`Warning`, error: t`Error` };
  const phases = { started: t`Started`, progress: t`In progress`, completed: t`Completed` };
  const outcomes = { success: t`Success`, error: t`Error`, cancelled: t`Cancelled` };
  return (
    <article className={`app-log-entry ${entry.level}`} data-log-entry="">
      <Icon className="app-log-entry-icon" size={15} aria-hidden="true" />
      <div className="app-log-entry-content">
        <div className="app-log-entry-heading">
          <span className="app-log-entry-source">{entry.source} · {levels[entry.level] ?? t`Unknown`}</span>
          <time dateTime={entry.timestamp} title={entry.timestamp}>{displayTime}</time>
        </div>
        <div className="app-log-entry-title">{entry.title}</div>
        {entry.context && (
          <div className="app-log-context" aria-label={t`Operation metadata`}>
            <span>{entry.context.operation}</span>
            <span>{entry.context.outcome ? outcomes[entry.context.outcome] ?? t`Unknown` : phases[entry.context.phase] ?? t`Unknown`}</span>
            {entry.context.duration_ms !== undefined && <span>{entry.context.duration_ms} ms</span>}
            <button type="button" title={entry.context.operation_id} onClick={() => onOperationFilter(entry.context!.operation_id)}>
              {entry.context.operation_id.slice(0, 8)}
            </button>
          </div>
        )}
        <CopyButton className="app-log-copy" text={serializeAppLogExport([entry])} title={t`Copy safe log entry`}>
          {t`Copy safe entry`}
        </CopyButton>
        {(detail || Object.keys(entry.context?.metrics ?? {}).length > 0) && (
          <details className="app-log-detail">
            <summary><ChevronRight size={12} aria-hidden="true" />{t({ message: "Details", context: "Activity log" })}</summary>
            <pre>{[detail, entry.context?.metrics && Object.keys(entry.context.metrics).length > 0
              ? JSON.stringify(entry.context.metrics, null, 2) : ""].filter(Boolean).join("\n\n")}</pre>
          </details>
        )}
      </div>
    </article>
  );
}

type LogGroup = { key: string; operationId?: string; entries: AppLogEntry[]; summary: AppLogEntry };

function groupLogs(entries: readonly AppLogEntry[]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  // Store snapshots are newest-first. Insert chronologically so equal
  // millisecond timestamps retain event order rather than randomly reversing.
  for (const entry of [...entries].reverse()) {
    const operationId = typeof entry.context?.operation_id === "string" && entry.context.operation_id
      ? entry.context.operation_id : undefined;
    const key = operationId ? `operation:${operationId}` : `entry:${entry.id}`;
    const existing = groups.get(key);
    if (existing) existing.entries.push(entry);
    else groups.set(key, { key, operationId, entries: [entry], summary: entry });
  }
  for (const group of groups.values()) {
    group.entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const newest = [...group.entries].reverse();
    group.summary = newest.find((entry) => !entry.context?.request_id && entry.context?.phase === "completed")
      ?? newest.find((entry) => !entry.context?.request_id) ?? newest[0];
  }
  return [...groups.values()].sort((a, b) => Date.parse(a.summary.timestamp) - Date.parse(b.summary.timestamp));
}

function ExportDialog({ entries, onClose }: { entries: readonly AppLogEntry[]; onClose: () => void }) {
  const { t } = useLingui();
  const [includeRaw, setIncludeRaw] = useState(false);
  const [snapshot] = useState(() => ({ safe: serializeAppLogExport(entries), raw: serializeAppLogExport(entries, true) }));
  const text = includeRaw ? snapshot.raw : snapshot.safe;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "lattice-diagnostics.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <ModalDialog label={t`Export diagnostic log`} onClose={onClose} describedBy="app-log-export-warning">
      <div className="app-log-export-dialog">
        <h2>{t`Export diagnostic log`}</h2>
        <p id="app-log-export-warning">{t`The safe export contains only validated operation metadata and known counts. It stays on this device until you copy or download it.`}</p>
        <CheckboxField
          checked={includeRaw}
          onChange={(event) => setIncludeRaw(event.target.checked)}
          label={t`Include raw diagnostic text`}
          description={t`Warning: raw diagnostic text may contain document content, file paths, or other sensitive information.`}
        />
        <pre className="app-log-export-preview" aria-label={t`Export preview`}>{text}</pre>
        <div className="modal-actions">
          <Button onClick={onClose}>{t`Cancel`}</Button>
          <Button onClick={() => void navigator.clipboard.writeText(text)}>{t`Copy JSON`}</Button>
          <Button variant="primary" onClick={download}><Download size={13} />{t`Download JSON`}</Button>
        </div>
      </div>
    </ModalDialog>
  );
}

/** Correlation ids belong in the app log, not in user-facing notification copy. */
function visibleToastDetail(detail: string): string {
  return detail.replace(/(?:^|\n)#[0-9a-f]{6}$/i, "").trim();
}

// Options arrive as a prop rather than being read from the store during render:
// an in-place update (`updateAppLog`, or a `dedupeKey` repeat) keeps the entry
// id and swaps the actions, so a memo keyed on anything derived from the id
// alone never invalidates. See `AppToastView` in app-log-store.ts.
function AppToast({ entry, options }: { entry: AppLogEntry; options?: AppToastOptions }) {
  const { t } = useLingui();
  const Icon = LOG_ICON[entry.level];
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
                title={t`Copy notification command`}
              >
                {t`Copy`}
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
        label={t`Dismiss notification`}
        size="compact"
        onClick={() => dismissAppToast(entry.id)}
      />
    </div>
  );
}

export function AppToastStack() {
  const toasts = useAppToastsSnapshot();
  return (
    <div className="app-toast-stack">
      {toasts.map(({ entry, options }) => (
        <AppToast key={entry.id} entry={entry} options={options} />
      ))}
    </div>
  );
}

export function AppLogsSettings() {
  const { t } = useLingui();
  const statuses = { success: t`Success`, error: t`Error`, cancelled: t`Cancelled`, started: t`Started`, progress: t`In progress`, completed: t`Completed` };
  const logs = useAppLogSnapshot();
  const [levelFilter, setLevelFilter] = useState<"all" | AppLogLevel>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [onlySlow, setOnlySlow] = useState(false);
  const [exportEntries, setExportEntries] = useState<AppLogEntry[] | null>(null);
  const [logFolderAvailable, setLogFolderAvailable] = useState(false);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const logPositionedRef = useRef(false);
  useEffect(() => {
    invoke<string>("get_app_log_dir")
      .then(() => setLogFolderAvailable(true))
      .catch(() => setLogFolderAvailable(false));
  }, []);
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const groups = groupLogs(logs);
  const visibleGroups = groups.filter((group) => {
    if (onlyFailures && !group.entries.some((entry) => entry.level === "error" || entry.context?.outcome === "error")) return false;
    if (onlySlow && !group.entries.some((entry) => typeof entry.context?.duration_ms === "number" && entry.context.duration_ms > 2_000)) return false;
    return group.entries.some((entry) => {
      if (levelFilter !== "all" && entry.level !== levelFilter) return false;
      if (!normalizedQuery) return true;
      const context = entry.context;
      return [entry.source, entry.title, entry.detail, entry.level, context?.operation,
        context?.operation_id, context?.phase, context?.outcome]
        .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuery));
    });
  });
  const visible = visibleGroups.flatMap((group) => group.entries);
  // Entries are stored newest-first; the text view reads like a terminal —
  // chronological, newest at the bottom. The panel fills the settings
  // viewport (the page itself never scrolls) and scrolls internally with
  // the app's own scrollbar.
  const logText = formatAppLogs([...visible].reverse());
  useLayoutEffect(() => {
    const panel = logViewportRef.current;
    if (!panel) return;
    // A newly opened log starts at the newest entry. Subsequent updates keep
    // following only while the reader remains near the bottom, so inspecting
    // an older entry is not interrupted by new activity.
    if (!logPositionedRef.current) {
      panel.scrollTop = panel.scrollHeight;
      logPositionedRef.current = true;
      return;
    }
    const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
    if (nearBottom) panel.scrollTop = panel.scrollHeight;
  }, [logText]);
  const openLogFolder = () => {
    if (!logFolderAvailable) return;
    // Keep arbitrary filesystem paths out of the WebView's opener authority.
    // The backend resolves and opens only Lattice's own log directory.
    void invoke("open_app_log_dir");
  };
  return (
    <div className="settings-section app-logs-settings">
      <SettingsSectionHeader
        title={t`Logs`}
        description={t`Shows 300 recent entries; disk logs rotate`}
      />
      <SettingsGroup title={t`Activity log`}>
        <div className="app-log-actions">
          <Button size="compact" disabled={visible.length === 0} onClick={() => setExportEntries([...visible])}>{t`Export…`}</Button>
          <Button size="compact" disabled={logs.length === 0} onClick={clearAppLogs}>{t`Clear`}</Button>
          <Button size="compact" disabled={!logFolderAvailable} onClick={openLogFolder}>
            <FolderOpen size={13} />
            {t`Open log folder`}
          </Button>
          <CheckboxField checked={onlyFailures} onChange={(event) => setOnlyFailures(event.target.checked)} label={t`Only failures`} />
          <CheckboxField checked={onlySlow} onChange={(event) => setOnlySlow(event.target.checked)} label={t`Only slow (over 2000 ms)`} />
          <SearchField
            aria-label={t`Search logs`}
            placeholder={t`Search logs…`}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onClear={() => setSearchQuery("")}
            clearLabel={t`Clear log search`}
            controlSize="compact"
            containerClassName="app-log-search"
          />
          <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value as "all" | AppLogLevel)}>
            <SelectTrigger className="app-log-level-filter" size="form" aria-label={t`Log level filter`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="all">{t`All levels`}</SelectItem>
              <SelectItem value="info">{t`Info`}</SelectItem>
              <SelectItem value="success">{t`Success`}</SelectItem>
              <SelectItem value="warning">{t`Warning`}</SelectItem>
              <SelectItem value="error">{t`Error`}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {visible.length === 0 ? (
          <EmptyState align="start" density="compact" description={logs.length === 0 ? t`No logs yet` : normalizedQuery ? t`No matching logs` : t`No logs at this level`} />
        ) : (
          <ScrollArea className="app-log-scroll" viewportRef={logViewportRef} fadeEdges={false}>
            <div className="app-log-list">
              {visibleGroups.map((group) => group.operationId ? (
                <details className="app-log-operation" key={group.key} data-log-operation="">
                  <summary>
                    <ChevronRight size={13} aria-hidden="true" />
                    <span>{group.summary.title}</span>
                    <span>{statuses[group.summary.context?.outcome ?? group.summary.context?.phase ?? "progress"] ?? t`Incomplete history`}</span>
                    {typeof group.summary.context?.duration_ms === "number" && <span>{group.summary.context.duration_ms} ms</span>}
                    <button type="button" title={group.operationId} onClick={(event) => {
                      event.preventDefault();
                      setSearchQuery(group.operationId!);
                    }}>{group.operationId.slice(0, 8)}</button>
                  </summary>
                  <div className="app-log-operation-timeline">
                    {group.entries.map((entry) => <LogEntryRow key={entry.id} entry={entry} onOperationFilter={setSearchQuery} />)}
                  </div>
                </details>
              ) : <LogEntryRow key={group.key} entry={group.summary} onOperationFilter={setSearchQuery} />)}
            </div>
          </ScrollArea>
        )}
      </SettingsGroup>
      {exportEntries && <ExportDialog entries={exportEntries} onClose={() => setExportEntries(null)} />}
    </div>
  );
}
