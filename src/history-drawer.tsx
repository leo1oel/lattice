import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, History, RotateCcw, Trash2, X } from "lucide-react";
import {
  annotatedDiffLines,
  changeKind,
  hunkedDiffLines,
  jumpLineForDiff,
  type DiffLine,
} from "./history-diff";

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

function visibleDiffLines(
  hunks: DiffLine[],
  full: DiffLine[],
  expandedSkips: Set<number>,
): DiffLine[] {
  const lines: DiffLine[] = [];
  let fullCursor = 0;
  hunks.forEach((hunk, hunkIndex) => {
    if (hunk.type !== "skip") {
      lines.push(hunk);
      fullCursor += 1;
      return;
    }
    const count = hunk.skippedCount ?? 0;
    if (expandedSkips.has(hunkIndex)) {
      lines.push(...full.slice(fullCursor, fullCursor + count));
    } else {
      lines.push(hunk);
    }
    fullCursor += count;
  });
  return lines;
}

function HistoryDiff(props: {
  change: FileChange;
  onOpenLine?: (path: string, line: number) => void;
}) {
  const kind = changeKind(props.change.before, props.change.after);
  const [expandedSkips, setExpandedSkips] = useState<Set<number>>(() => new Set());
  const hunks = useMemo(
    () => hunkedDiffLines(props.change.before, props.change.after, 3),
    [props.change.after, props.change.before],
  );
  const full = useMemo(
    () => annotatedDiffLines(props.change.before, props.change.after),
    [props.change.after, props.change.before],
  );
  const visibleLines = useMemo(
    () => visibleDiffLines(hunks, full, expandedSkips),
    [expandedSkips, full, hunks],
  );

  return (
    <div className="history-diff">
      <div className="history-diff-meta">
        <strong>{props.change.path}</strong>
        <span>{kind}</span>
      </div>
      <pre className="history-diff-body" aria-label={`Diff for ${props.change.path}`}>
        {visibleLines.map((line, index) => {
          if (line.type === "skip") {
            const hunkIndex = hunks.findIndex((item, itemIndex) => (
              item.type === "skip"
              && item.skippedCount === line.skippedCount
              && item.beforeLine === line.beforeLine
              && item.afterLine === line.afterLine
              && !expandedSkips.has(itemIndex)
            ));
            return (
              <button
                key={`skip-${index}-${line.beforeLine}-${line.afterLine}`}
                type="button"
                className="history-diff-line skip"
                onClick={() => {
                  if (hunkIndex < 0) return;
                  setExpandedSkips((current) => new Set(current).add(hunkIndex));
                }}
              >
                ⋯ {line.text} — click to expand
              </button>
            );
          }
          const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const jumpLine = jumpLineForDiff(line);
          const clickable = Boolean(props.onOpenLine && jumpLine != null);
          return (
            <code
              key={`${line.type}-${line.beforeLine ?? "x"}-${line.afterLine ?? "y"}-${index}`}
              className={`history-diff-line ${line.type}${clickable ? " clickable" : ""}`}
              title={clickable ? `Open ${props.change.path}:${jumpLine}` : undefined}
              onClick={() => {
                if (clickable && jumpLine != null) props.onOpenLine?.(props.change.path, jumpLine);
              }}
            >
              {`${prefix} ${line.text}`}
            </code>
          );
        })}
      </pre>
    </div>
  );
}

export function HistoryDrawer(props: {
  history: HistoryItem[];
  onClose: () => void;
  onRevert: (id: string) => void;
  onRevertFile?: (id: string, path: string) => void;
  onDelete: (id: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<TransactionRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [activePath, setActivePath] = useState("");

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
        <div className="drawer-header">
          <div><History size={16} /><span>Project history</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
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
      </aside>
    </div>
  );
}
