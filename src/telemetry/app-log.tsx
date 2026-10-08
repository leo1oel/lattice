import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Download, FolderOpen } from "lucide-react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { Button } from "../components/ui/button";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup } from "../components/ui/settings-row";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import { SettingsSelect } from "../settings/settings-controls";
import { ModalDialog } from "../components/ui/modal-dialog";
import { CheckboxField } from "../components/ui/checkbox-field";
import { createAppLogExport } from "./app-log-export";
import {
  clearAppLogs,
  formatAppLogs,
  useAppLogSnapshot,
  visibleToastDetail,
  type AppLogEntry,
  type AppLogLevel,
} from "./app-log-store";

/** The terse level column; the full name is its tooltip. */
const LOG_LEVEL = { info: msg`INFO`, success: msg`OK`, warning: msg`WARN`, error: msg`ERROR` };
const LOG_LEVELS = ["info", "success", "warning", "error"] as const;
/** Readable names for entry levels and for operation phases and outcomes. */
const STATUS_LABELS = {
  info: msg`Info`,
  success: msg`Success`,
  warning: msg`Warning`,
  error: msg`Error`,
  cancelled: msg`Cancelled`,
  started: msg`Started`,
  progress: msg`In progress`,
  completed: msg`Completed`,
};
type LogStatus = keyof typeof STATUS_LABELS;

function useStatusLabel() {
  const { t } = useLingui();
  return (status: string, fallback = t`Unknown`) =>
    Object.hasOwn(STATUS_LABELS, status) ? t(STATUS_LABELS[status as LogStatus]) : fallback;
}

/** The one-line head shared by a single entry and a whole operation. */
function LogSummary(props: { entry: AppLogEntry; statusTitle: string; className: string; title: string; fields: string }) {
  const { t } = useLingui();
  const { timestamp } = props.entry;
  return (
    <>
      <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}><span className="app-log-date">{timestamp.slice(0, 11)}</span>{timestamp.slice(11)}</time>
      <span className="app-log-severity" title={props.statusTitle}>{t(LOG_LEVEL[props.entry.level])}</span>
      <span className={props.className}>{props.title}<span className="app-log-inline-fields">{props.fields}</span></span>
      <ChevronRight className="app-log-chevron" size={13} aria-hidden="true" />
    </>
  );
}

function LogEntryRow({ entry, onOperationFilter, onExport }: { entry: AppLogEntry; onOperationFilter: (id: string) => void; onExport: (entries: AppLogEntry[]) => void }) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  const detail = entry.context ? visibleToastDetail(entry.detail) : entry.detail;
  // Console capture's event name is less useful than the actual diagnostic.
  // Keep the original event and full text in the expanded record and export.
  const summary = /^console\.(warn|error|info|log)$/.test(entry.title) && detail.trim()
    ? detail.trim().split("\n")[0] : entry.title;
  const level = statusLabel(entry.level);
  return (
    <details className={`app-log-entry ${entry.level}`} data-log-entry="">
      <summary className="app-log-entry-summary" tabIndex={0}>
        {/* eslint-disable-next-line lingui/no-unlocalized-strings -- structured log field name */}
        <LogSummary entry={entry} statusTitle={level} className="app-log-entry-title" title={summary} fields={` source=${entry.source}`} />
      </summary>
      <div className="app-log-entry-content">
        <div className="app-log-entry-heading">
          <span>{entry.source} · {level} · {new Date(entry.timestamp).toLocaleString()}</span>
          <Button size="compact" onClick={() => onExport([entry])}><Download size={12} />{t`Export…`}</Button>
        </div>
        <pre className="app-log-message">{[entry.title, detail].filter(Boolean).join("\n\n")}</pre>
        {entry.context && (
          <>
            <div className="app-log-context" aria-label={t`Operation metadata`}>
              <span>{entry.context.operation}</span>
              <span>{statusLabel(entry.context.outcome || entry.context.phase)}</span>
              {entry.context.duration_ms !== undefined && <span>{entry.context.duration_ms} ms</span>}
              <button type="button" title={entry.context.operation_id} onClick={() => onOperationFilter(entry.context!.operation_id)}>
                {entry.context.operation_id.slice(0, 8)}
              </button>
            </div>
            <pre className="app-log-fields">{JSON.stringify(entry.context, null, 2)}</pre>
          </>
        )}
      </div>
    </details>
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

type RuntimeLogs = {
  platform: string;
  arch: string;
  files: { name: string; content: string; truncated: boolean; error?: string }[];
};

function ExportDialog({ entries, onClose }: { entries: readonly AppLogEntry[]; onClose: () => void }) {
  const { t } = useLingui();
  const [includeRaw, setIncludeRaw] = useState(false);
  const [includeRuntime, setIncludeRuntime] = useState(false);
  const [runtime, setRuntime] = useState<{ logs?: RuntimeLogs; error?: string }>({});
  const request = useRef(0);
  const [snapshot] = useState(() => ({ safe: createAppLogExport(entries), raw: createAppLogExport(entries, true) }));
  const text = JSON.stringify({
    ...(includeRaw ? snapshot.raw : snapshot.safe),
    ...(includeRuntime && runtime.logs ? { runtime_logs: runtime.logs } : {}),
  }, null, 2);
  const ready = !includeRuntime || Boolean(runtime.logs);
  useEffect(() => () => { request.current += 1; }, []);
  const collectRuntime = () => {
    const generation = ++request.current;
    setRuntime({});
    void invoke<RuntimeLogs>("collect_diagnostic_logs").then(
      (logs) => { if (generation === request.current) setRuntime({ logs }); },
      (error: unknown) => { if (generation === request.current) setRuntime({ error: String(error) }); },
    );
  };
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
        <p id="app-log-export-warning">{t`Only operation metadata and counts. Nothing leaves this Mac until you copy or download it`}</p>
        <CheckboxField
          checked={includeRaw}
          onChange={(event) => setIncludeRaw(event.target.checked)}
          label={t`Include raw diagnostic text`}
          description={t`May include document text and file paths`}
        />
        <CheckboxField
          checked={includeRuntime}
          onChange={(event) => {
            setIncludeRuntime(event.target.checked);
            if (event.target.checked) collectRuntime();
            else { request.current += 1; setRuntime({}); }
          }}
          label={t`Include app and Agent runtime logs`}
          description={t`For Agent failures. Credentials are masked, but paths and document text may remain`}
        />
        {includeRuntime && !runtime.logs && (runtime.error ? (
          <div role="alert">
            <p>{t`Could not collect runtime logs.`} {runtime.error}</p>
            <Button size="compact" onClick={collectRuntime}>{t`Retry`}</Button>
          </div>
        ) : <p role="status">{t`Collecting runtime logs…`}</p>)}
        <pre className="app-log-export-preview" aria-label={t`Export preview`}>{text}</pre>
        <div className="modal-actions">
          <Button onClick={onClose}>{t`Cancel`}</Button>
          <Button disabled={!ready} onClick={() => void navigator.clipboard.writeText(text)}>{t`Copy JSON`}</Button>
          <Button disabled={!ready} variant="primary" onClick={download}><Download size={13} />{t`Download JSON`}</Button>
        </div>
      </div>
    </ModalDialog>
  );
}

export function AppLogsSettings() {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  const logs = useAppLogSnapshot();
  const [levelFilter, setLevelFilter] = useState<"all" | AppLogLevel>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [exportEntries, setExportEntries] = useState<AppLogEntry[] | null>(null);
  const [logFolderAvailable, setLogFolderAvailable] = useState(false);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const logPositionedRef = useRef(false);
  useEffect(() => {
    void invoke<string>("get_app_log_dir").then(() => true, () => false).then(setLogFolderAvailable);
  }, []);
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleGroups = groupLogs(logs).filter((group) => group.entries.some((entry) => {
    if (levelFilter !== "all" && entry.level !== levelFilter) return false;
    if (!normalizedQuery) return true;
    const context = entry.context;
    return [entry.source, entry.title, entry.detail, entry.level, context?.operation,
      context?.operation_id, context?.phase, context?.outcome]
      .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuery));
  }));
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
    const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
    if (!logPositionedRef.current || nearBottom) panel.scrollTop = panel.scrollHeight;
    logPositionedRef.current = true;
  }, [logText]);
  const openLogFolder = () => {
    if (!logFolderAvailable) return;
    // Keep arbitrary filesystem paths out of the WebView's opener authority.
    // The backend resolves and opens only Lattice's own log directory.
    void invoke("open_app_log_dir");
  };
  const entryRow = (entry: AppLogEntry, key: string): ReactNode => (
    <LogEntryRow key={key} entry={entry} onOperationFilter={setSearchQuery} onExport={setExportEntries} />
  );
  return (
    <div className="settings-section app-logs-settings">
      <SettingsSectionHeader title={t`Logs`} description={t`The last 300 entries`} />
      <SettingsGroup>
        <div className="app-log-actions">
          <div className="app-log-query-row">
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
            <SettingsSelect
              className="app-log-level-filter"
              label={t`Log level filter`}
              value={levelFilter}
              options={{
                all: t`All levels`,
                ...Object.fromEntries(LOG_LEVELS.map((level) => [level, statusLabel(level)])) as Record<AppLogLevel, string>,
              }}
              onChange={setLevelFilter}
            />
          </div>
          <div className="app-log-action-row">
            <Button size="compact" onClick={() => setExportEntries([...visible])}><Download size={13} />{t`Export…`}</Button>
            <Button size="compact" disabled={logs.length === 0} onClick={clearAppLogs}>{t`Clear`}</Button>
            <Button size="compact" disabled={!logFolderAvailable} onClick={openLogFolder}><FolderOpen size={13} />{t`Open log folder`}</Button>
          </div>
        </div>
        {visible.length === 0 ? (
          <EmptyState align="start" density="compact" description={logs.length === 0 ? t`No logs yet` : normalizedQuery ? t`No matching logs` : t`No logs at this level`} />
        ) : (
          <ScrollArea className="app-log-scroll" viewportRef={logViewportRef} fadeEdges={false}>
            <div className="app-log-list">
              {visibleGroups.map((group) => group.operationId ? (
                <details className={`app-log-operation ${group.summary.level}`} key={group.key} data-log-operation="">
                  <summary tabIndex={0}>
                    <LogSummary
                      entry={group.summary}
                      statusTitle={statusLabel(group.summary.context?.outcome ?? group.summary.context?.phase ?? "progress", t`Incomplete history`)}
                      className="app-log-operation-title"
                      title={group.summary.title}
                      // eslint-disable-next-line lingui/no-unlocalized-strings -- structured log field names
                      fields={`${group.summary.context?.duration_ms !== undefined ? ` duration_ms=${group.summary.context.duration_ms}` : ""} operation_id=${group.operationId}`}
                    />
                  </summary>
                  <div className="app-log-operation-timeline">
                    {group.entries.map((entry) => entryRow(entry, entry.id))}
                  </div>
                </details>
              ) : entryRow(group.summary, group.key))}
            </div>
          </ScrollArea>
        )}
      </SettingsGroup>
      {exportEntries && <ExportDialog entries={exportEntries} onClose={() => setExportEntries(null)} />}
    </div>
  );
}
