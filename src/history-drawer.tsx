import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, History, RotateCcw, Trash2, X } from "lucide-react";
import { HistoryDiff, VersionsTimeline, versionsTimelineCss } from "./versions-timeline";

export type HistoryItem = {
  id: string;
  label: string;
  timestamp: string;
  files: string[];
};

type FileChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

type TransactionRecord = {
  id: string;
  label: string;
  timestamp: string;
  changes: FileChange[];
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type HistoryTab = "changes" | "versions";

// Session-scoped memory of the last-used tab. "Versions" is the default; the
// choice is intentionally not persisted to localStorage.
let lastUsedTab: HistoryTab = "versions";

export function HistoryDrawer(props: {
  history: HistoryItem[];
  onClose: () => void;
  onRevert: (id: string) => void;
  onRevertFile?: (id: string, path: string) => void;
  onDelete: (id: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onVersionsChanged?: () => void;
}) {
  const [tab, setTab] = useState<HistoryTab>(lastUsedTab);
  const userPickedTab = useRef(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<TransactionRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [activePath, setActivePath] = useState("");

  const selectTab = (next: HistoryTab) => {
    userPickedTab.current = true;
    lastUsedTab = next;
    setTab(next);
  };

  const toggleEntry = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setEntry(null);
      setActivePath("");
      setError("");
      setLoadingId(null);
      return;
    }
    setExpandedId(id);
    setEntry(null);
    setActivePath("");
    setError("");
    setLoadingId(id);
    void invoke<TransactionRecord>("get_history_entry", { transactionId: id })
      .then((record) => {
        setEntry(record);
        setActivePath(record.changes[0]?.path ?? "");
      })
      .catch((reason) => {
        setEntry(null);
        setError(message(reason));
      })
      .finally(() => setLoadingId((current) => (current === id ? null : current)));
  };

  const activeChange = entry?.changes.find((change) => change.path === activePath) ?? entry?.changes[0] ?? null;

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <style>{versionsTimelineCss}</style>
        <div className="drawer-header">
          <div><History size={16} /><span>Project history</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <div className="versions-tabs" role="tablist" aria-label="History views">
          <button
            type="button"
            role="tab"
            className={`versions-tab ${tab === "changes" ? "active" : ""}`}
            aria-selected={tab === "changes"}
            onClick={() => selectTab("changes")}
          >
            Changes
          </button>
          <button
            type="button"
            role="tab"
            className={`versions-tab ${tab === "versions" ? "active" : ""}`}
            aria-selected={tab === "versions"}
            onClick={() => selectTab("versions")}
          >
            Versions
          </button>
        </div>
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
              Every direct edit, paper import, and agent change is stored as a project transaction.
              Expand an entry to inspect hunked file diffs; click a line to jump into the editor.
            </p>
            <div className="history-list">
              {props.history.map((item) => {
                const expanded = expandedId === item.id;
                return (
                  <div className={`history-item ${expanded ? "expanded" : ""}`} key={item.id}>
                    <div className="history-dot" />
                    <div className="history-body">
                      <button
                        type="button"
                        className="history-expand"
                        aria-expanded={expanded}
                        onClick={() => toggleEntry(item.id)}
                      >
                        <strong>{item.label}</strong>
                        <span><Clock3 size={11} /> {new Date(item.timestamp).toLocaleString()}</span>
                        <p>{item.files.join(", ")}</p>
                      </button>
                      {expanded && (
                        <div className="history-entry-preview">
                          {loadingId === item.id && <p className="history-diff-loading">Loading diff…</p>}
                          {error && expandedId === item.id && <p className="history-diff-error">{error}</p>}
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
                      <button type="button" title="Restore the state before this change" onClick={() => props.onRevert(item.id)}><RotateCcw size={14} /></button>
                      <button type="button" className="history-delete" title="Delete this history entry" onClick={() => props.onDelete(item.id)}><Trash2 size={13} /></button>
                    </div>
                  </div>
                );
              })}
              {!props.history.length && <p className="empty-history">No changes recorded yet.</p>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
