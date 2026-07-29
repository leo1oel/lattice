import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, History, RotateCcw, Trash2 } from "lucide-react";
import { EmptyState } from "./components/ui/empty-state";
import { PanelHeader } from "./components/ui/panel-header";
import { HistoryDiff, VersionsTimeline, versionsTimelineCss } from "./versions-timeline";
import { OverleafHistoryPanel } from "./overleaf-history";
import { SlidingTabs } from "./motion";
import { ResizableDrawer } from "./resizable-drawer";

export type HistoryItem = {
  id: string;
  label: string;
  timestamp: string;
  files: string[];
  actor?: "user" | "agent" | "citation" | "system" | string;
  kind?: string;
  source?: string;
  threadId?: string | null;
  threadTitle?: string | null;
  checkpointRef?: string | null;
  turnCount?: number | null;
  undoOf?: string | null;
  fileSummaries?: Array<{
    path: string;
    kind: string;
    additions: number;
    deletions: number;
  }>;
  restoreAvailable?: boolean;
  restoreUnavailableReason?: string | null;
};

type FileChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

type TransactionRecord = {
  schemaVersion?: number;
  id: string;
  label: string;
  timestamp: string;
  actor?: string | null;
  kind?: string | null;
  source?: string | null;
  threadId?: string | null;
  checkpointRef?: string | null;
  undoOf?: string | null;
  changes: FileChange[];
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type HistoryTab = "changes" | "versions" | "overleaf";
type HistoryFilter = "all" | "user" | "agent" | "citation";

// Session-scoped memory of the last-used tab. "Versions" is the default; the
// choice is intentionally not persisted to localStorage.
let lastUsedTab: HistoryTab = "versions";

export function HistoryDrawer(props: {
  history: HistoryItem[];
  onClose: () => void;
  onRevert: (item: HistoryItem) => void;
  onRevertFile?: (id: string, path: string) => void;
  onDelete: (id: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onVersionsChanged?: () => void;
  /** Overleaf keeps its own history server-side; offer it only when linked. */
  overleafLinked?: boolean;
  /** After a restore on Overleaf's side, which leaves the local files untouched. */
  onOverleafRestored?: () => void;
}) {
  // A project that was linked last time may not be now, and the remembered tab
  // would otherwise land on an Overleaf panel with nothing behind it.
  const [tab, setTab] = useState<HistoryTab>(
    lastUsedTab === "overleaf" && !props.overleafLinked ? "versions" : lastUsedTab,
  );
  const userPickedTab = useRef(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<TransactionRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [activePath, setActivePath] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");

  const selectTab = (next: HistoryTab) => {
    userPickedTab.current = true;
    lastUsedTab = next;
    setTab(next);
  };

  const toggleEntry = (item: HistoryItem) => {
    if (expandedId === item.id) {
      setExpandedId(null);
      setEntry(null);
      setActivePath("");
      setError("");
      setLoadingId(null);
      return;
    }
    setExpandedId(item.id);
    setEntry(null);
    setActivePath("");
    setError("");
    if (item.kind === "agent-checkpoint") {
      setLoadingId(null);
      return;
    }
    setLoadingId(item.id);
    void invoke<TransactionRecord>("get_history_entry", { transactionId: item.id })
      .then((record) => {
        setEntry(record);
        setActivePath(record.changes[0]?.path ?? "");
      })
      .catch((reason) => {
        setEntry(null);
        setError(message(reason));
      })
      .finally(() => setLoadingId((current) => (current === item.id ? null : current)));
  };

  const activeChange = entry?.changes.find((change) => change.path === activePath) ?? entry?.changes[0] ?? null;
  const visibleHistory = props.history.filter((item) => {
    if (filter === "all") return true;
    return (item.actor ?? "user") === filter;
  });

  return (
    <ResizableDrawer onClose={props.onClose}>
        <style>{versionsTimelineCss}</style>
        <PanelHeader
          className="drawer-header"
          icon={<History size={16} />}
          title="Project history"
          onClose={props.onClose}
        />
        <SlidingTabs
          value={tab}
          onChange={(next) => selectTab(next as HistoryTab)}
          ariaLabel="History views"
          variant="underline"
          className="versions-tabs"
          tabClassName="versions-tab"
          items={[
            { value: "changes", label: "Changes" },
            { value: "versions", label: "Versions" },
            ...(props.overleafLinked ? [{ value: "overleaf", label: "Overleaf" }] : []),
          ]}
        />
        {tab === "overleaf" && props.overleafLinked && (
          <OverleafHistoryPanel
            onClose={props.onClose}
            onOpenFile={props.onOpenFile}
            onRestored={props.onOverleafRestored}
          />
        )}
        {tab === "versions" && (
          <VersionsTimeline
            onVersionsChanged={props.onVersionsChanged}
            onGitUnreachable={() => {
              // The git commands are missing entirely (e.g. an older backend
              // build). If the user hasn't picked a tab themselves, fall back
              // to the Changes tab so the drawer stays useful.
              if (userPickedTab.current) return;
              lastUsedTab = "changes";
              setTab("changes");
            }}
          />
        )}
        {tab === "changes" && (
          <>
            <p className="drawer-copy">
              Changes from you, the Agent, and citation tools share one timeline. Restoring a
              local change creates a new history entry, so the original record stays available.
            </p>
            <div className="history-filters" aria-label="Filter project changes">
              {([
                ["all", "All"],
                ["user", "You"],
                ["agent", "Agent"],
                ["citation", "Citations"],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={filter === value ? "active" : ""}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="history-list">
              {visibleHistory.map((item) => {
                const expanded = expandedId === item.id;
                const actor = item.actor === "agent"
                  ? "Agent"
                  : item.actor === "citation"
                    ? "Citation tool"
                    : item.actor === "system"
                      ? "Lattice"
                      : "You";
                const restoreTitle = item.restoreAvailable === false
                  ? item.restoreUnavailableReason || "Open this Agent task before restoring its files"
                  : item.kind === "agent-checkpoint"
                    ? "Undo this Agent turn's file changes"
                    : "Restore the state before this change";
                return (
                  <div className={`history-item ${expanded ? "expanded" : ""}`} key={item.id}>
                    <div className={`history-dot ${item.actor ?? "user"}`} />
                    <div className="history-body">
                      <button
                        type="button"
                        className="history-expand"
                        aria-expanded={expanded}
                        onClick={() => toggleEntry(item)}
                      >
                        <strong>{item.label}</strong>
                        <span>
                          <span className={`history-actor ${item.actor ?? "user"}`}>{actor}</span>
                          <Clock3 size={11} /> {new Date(item.timestamp).toLocaleString()}
                        </span>
                        <p>{item.files.join(", ")}</p>
                      </button>
                      {expanded && (
                        <div className="history-entry-preview">
                          {loadingId === item.id && <p className="history-diff-loading">Loading diff…</p>}
                          {error && expandedId === item.id && <p className="history-diff-error" role="alert">{error}</p>}
                          {item.kind === "agent-checkpoint" && (
                            <div className="history-checkpoint-summary">
                              {item.threadTitle && <strong>Agent task: {item.threadTitle}</strong>}
                              {item.fileSummaries?.map((file) => (
                                <div key={file.path}>
                                  <span>{file.path}</span>
                                  <small>
                                    {file.kind}
                                    {file.additions || file.deletions
                                      ? ` · +${file.additions} −${file.deletions}`
                                      : ""}
                                  </small>
                                </div>
                              ))}
                            </div>
                          )}
                          {entry && entry.id === item.id && (
                            <>
                              {entry.changes.length > 1 && (
                                <div className="history-file-tabs">
                                  {entry.changes.map((change) => (
                                    <button
                                      key={change.path}
                                      type="button"
                                      className={change.path === activeChange?.path ? "active" : ""}
                                      onClick={() => setActivePath(change.path)}
                                    >
                                      {change.path}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {activeChange && (
                                <HistoryDiff
                                  key={`${item.id}:${activeChange.path}`}
                                  change={activeChange}
                                  onOpenLine={props.onOpenFile
                                    ? (path, line) => {
                                        props.onOpenFile?.(path, line);
                                        props.onClose();
                                      }
                                    : undefined}
                                />
                              )}
                              {activeChange && props.onRevertFile && (
                                <button
                                  type="button"
                                  className="history-restore-file"
                                  title={`Restore only ${activeChange.path}`}
                                  onClick={() => props.onRevertFile?.(item.id, activeChange.path)}
                                >
                                  <RotateCcw size={12} /> Restore this file
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        title={restoreTitle}
                        disabled={item.restoreAvailable === false}
                        onClick={() => props.onRevert(item)}
                      >
                        <RotateCcw size={14} />
                      </button>
                      {item.kind !== "agent-checkpoint" && (
                        <button type="button" className="history-delete" title="Delete this history entry" onClick={() => props.onDelete(item.id)}><Trash2 size={13} /></button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!visibleHistory.length && (
                <EmptyState description={props.history.length ? "No changes match this filter." : "No changes recorded yet."} />
              )}
            </div>
          </>
        )}
    </ResizableDrawer>
  );
}
