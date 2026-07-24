/**
 * Overleaf-style git "Versions" timeline for the history drawer, plus the
 * shared hunked-diff renderer (`HistoryDiff`) that both the Changes tab and
 * the Versions tab use. The renderer lives here (not in history-drawer.tsx)
 * so the drawer can import it without creating an import cycle.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FilePen,
  FilePlus2,
  FileX2,
  GitBranch,
  MoveRight,
  RefreshCw,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import type { GitFileDiff, GitLogEntry, GitLogFileKind } from "./app-types";
import type { GitStatus } from "./git-panel";
import { peerColorForName } from "./collab-colors";
import { relativeTime } from "./app-utils";
import {
  annotatedDiffLines,
  changeKind,
  hunkedDiffLines,
  jumpLineForDiff,
  type DiffLine,
} from "./history-diff";

export type DiffFileChange = {
  path: string;
  before?: string | null;
  after?: string | null;
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

export function HistoryDiff(props: {
  change: DiffFileChange;
  onOpenLine?: (path: string, line: number) => void;
  headerAction?: ReactNode;
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
        {props.headerAction}
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

function FileKindIcon(props: { kind: GitLogFileKind }) {
  if (props.kind === "added") return <FilePlus2 size={12} className="versions-kind added" aria-hidden />;
  if (props.kind === "deleted") return <FileX2 size={12} className="versions-kind deleted" aria-hidden />;
  if (props.kind === "renamed") return <MoveRight size={12} className="versions-kind renamed" aria-hidden />;
  return <FilePen size={12} className="versions-kind modified" aria-hidden />;
}

type Phase = "loading" | "unavailable" | "no-repo" | "ready" | "error";

export function VersionsTimeline(props: {
  /** Called after any restore or manual save so the app can reload files. */
  onVersionsChanged?: () => void;
  /** Called when the git backend itself is unreachable (`git_status` rejects). */
  onGitUnreachable?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<{ hash: string; path: string } | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [diffError, setDiffError] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");

  const callbacksRef = useRef(props);
  useEffect(() => {
    callbacksRef.current = props;
  });
  const diffSeq = useRef(0);

  const load = useCallback(async () => {
    setError("");
    try {
      const status = await invoke<GitStatus>("git_status");
      if (!status.available) {
        setPhase("unavailable");
        return;
      }
      if (!status.repository) {
        setPhase("no-repo");
        return;
      }
      try {
        setEntries(await invoke<GitLogEntry[]>("git_log", { limit: 100 }));
      } catch (reason) {
        setError(message(reason));
      }
      setPhase("ready");
    } catch (reason) {
      // The `git_*` commands themselves are missing or broken (e.g. an older
      // backend build). Show the failure here and let the drawer fall back to
      // the Changes tab so it stays useful.
      setError(message(reason));
      setPhase("error");
      callbacksRef.current.onGitUnreachable?.();
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enableTracking = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke<GitStatus>("git_init");
      await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const hash = await invoke<string | null>("git_auto_commit", {
        message: saveLabel.trim() || "Saved version",
        author: null,
      });
      setSaveOpen(false);
      setSaveLabel("");
      setNotice(hash ? "Version saved." : "No changes since the last version.");
      if (hash) callbacksRef.current.onVersionsChanged?.();
      await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleEntry = (hash: string) => {
    setNotice("");
    setActiveFile(null);
    setDiff(null);
    setDiffError("");
    setExpandedHash((current) => (current === hash ? null : hash));
  };

  const openFileDiff = async (hash: string, path: string) => {
    const seq = (diffSeq.current += 1);
    setActiveFile({ hash, path });
    setDiff(null);
    setDiffError("");
    try {
      const next = await invoke<GitFileDiff>("git_show_diff", { rev: hash, path });
      if (diffSeq.current === seq) setDiff(next);
    } catch (reason) {
      if (diffSeq.current === seq) setDiffError(message(reason));
    }
  };

  const restoreFile = async (hash: string, path: string) => {
    if (!window.confirm(`Restore ${path} to this version? Your current file will be overwritten.`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await invoke("git_restore_file", { rev: hash, path });
      setNotice(`Restored ${path}.`);
      callbacksRef.current.onVersionsChanged?.();
      await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const restoreProject = async (hash: string) => {
    const warning = "Restore the project to this version? "
      + "All current files will be rewound to that point — nothing is lost, "
      + "and the restore itself is saved as a new version.";
    if (!window.confirm(warning)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await invoke<string>("git_restore_project", { rev: hash });
      setNotice("Project restored.");
      callbacksRef.current.onVersionsChanged?.();
      await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading") {
    return <p className="versions-loading">Loading versions…</p>;
  }
  if (phase === "unavailable") {
    return (
      <p className="versions-note">
        Version history needs Git, which isn&apos;t available on this Mac.
      </p>
    );
  }
  if (phase === "error") {
    return (
      <div className="versions-empty">
        <p className="versions-error">Version history is unavailable: {error}</p>
        <button
          type="button"
          className="versions-save"
          onClick={() => {
            setPhase("loading");
            void load();
          }}
        >
          <RefreshCw size={12} /> Try again
        </button>
      </div>
    );
  }
  if (phase === "no-repo") {
    return (
      <div className="versions-empty">
        <p>Track versions of this project to see who changed what and roll back safely.</p>
        {error && <p className="versions-error">{error}</p>}
        <button
          type="button"
          className="git-commit-button versions-enable"
          disabled={busy}
          onClick={() => void enableTracking()}
        >
          <GitBranch size={13} /> Enable version tracking
        </button>
      </div>
    );
  }

  const renderDiff = (target: { hash: string; path: string }) => {
    if (diffError) return <p className="history-diff-error">{diffError}</p>;
    if (!diff) return <p className="history-diff-loading">Loading diff…</p>;
    const restoreButton = (
      <button
        type="button"
        className="versions-restore-file"
        disabled={busy}
        title={`Restore ${target.path} to this version`}
        onClick={() => void restoreFile(target.hash, target.path)}
      >
        <RotateCcw size={10} /> Restore this file
      </button>
    );
    if (diff.binary) {
      return (
        <div className="history-diff">
          <div className="history-diff-meta">
            <strong>{target.path}</strong>
            <span>binary</span>
            {restoreButton}
          </div>
          <p className="versions-binary">Binary file changed.</p>
        </div>
      );
    }
    return (
      <HistoryDiff
        key={`${target.hash}:${target.path}`}
        change={{ path: target.path, before: diff.before, after: diff.after }}
        headerAction={restoreButton}
      />
    );
  };

  return (
    <div className="versions-root">
      <div className="versions-header">
        {saveOpen ? (
          <form className="versions-save-form" onSubmit={(event) => void submitSave(event)}>
            <input
              className="versions-save-input"
              autoFocus
              placeholder="Label this version (optional)"
              aria-label="Version label"
              value={saveLabel}
              onChange={(event) => setSaveLabel(event.target.value)}
            />
            <button type="submit" className="versions-save" disabled={busy}>
              <Save size={12} /> Save
            </button>
            <button
              type="button"
              className="versions-refresh"
              title="Cancel"
              onClick={() => {
                setSaveOpen(false);
                setSaveLabel("");
              }}
            >
              <X size={13} />
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="versions-save"
              disabled={busy}
              onClick={() => {
                setNotice("");
                setSaveOpen(true);
              }}
            >
              <Save size={12} /> Save version
            </button>
            <button
              type="button"
              className="versions-refresh"
              title="Refresh versions"
              onClick={() => void load()}
            >
              <RefreshCw size={13} />
            </button>
          </>
        )}
      </div>
      {error && <p className="versions-error">{error}</p>}
      {notice && <p className="versions-notice">{notice}</p>}
      {!entries.length && (
        <p className="versions-note">
          No versions yet. Versions are saved automatically as you work, or press Save version.
        </p>
      )}
      <div className="versions-list">
        {entries.map((entry) => {
          const expanded = expandedHash === entry.hash;
          const color = peerColorForName(entry.authorName || "Unknown");
          const fileCount = `${entry.files.length} file${entry.files.length === 1 ? "" : "s"}`;
          return (
            <div className={`versions-entry ${expanded ? "expanded" : ""}`} key={entry.hash}>
              <button
                type="button"
                className="versions-entry-head"
                aria-expanded={expanded}
                onClick={() => toggleEntry(entry.hash)}
              >
                <span className="versions-entry-top">
                  <span
                    className="versions-author"
                    style={{ background: color.colorLight, color: color.color }}
                  >
                    {entry.authorName || "Unknown"}
                  </span>
                  <span className="versions-time" title={new Date(entry.timestamp).toLocaleString()}>
                    {relativeTime(entry.timestamp)}
                  </span>
                  <span className="versions-count">{fileCount}</span>
                </span>
                <span className="versions-entry-message">{entry.message}</span>
              </button>
              {expanded && (
                <div className="versions-entry-body">
                  <div className="versions-files">
                    {entry.files.map((file) => {
                      const active = activeFile?.hash === entry.hash && activeFile.path === file.path;
                      return (
                        <button
                          key={file.path}
                          type="button"
                          className={`versions-file ${active ? "active" : ""}`}
                          title={`${file.kind}: ${file.path}`}
                          onClick={() => void openFileDiff(entry.hash, file.path)}
                        >
                          <FileKindIcon kind={file.kind} />
                          <span>{file.path}</span>
                        </button>
                      );
                    })}
                  </div>
                  {activeFile?.hash === entry.hash && renderDiff(activeFile)}
                  <button
                    type="button"
                    className="versions-restore-project"
                    disabled={busy}
                    onClick={() => void restoreProject(entry.hash)}
                  >
                    <RotateCcw size={12} /> Restore project to this version
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Scoped styles for the tabs and the timeline. App.css is off-limits for this
 * feature, so the drawer renders these once in a <style> tag; every rule is
 * prefixed with `.versions-` and uses the shared theme tokens, so light and
 * dark themes both work.
 */
export const versionsTimelineCss = `
.versions-tabs { display: flex; gap: 2px; margin-top: 8px; border-bottom: 1px solid var(--line); }
.versions-tab { height: 28px; padding: 0 10px; background: transparent; color: var(--muted); font-size: 11px; font-weight: 600; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; }
.versions-tab:hover { color: var(--text); background: var(--line); }
.versions-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.versions-loading, .versions-note { margin: 14px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.versions-error { margin: 8px 0 0; color: var(--danger); font-size: 10px; }
.versions-notice { margin: 8px 0 0; color: var(--success); font-size: 10px; }
.versions-empty { margin-top: 14px; display: grid; gap: 10px; justify-items: start; }
.versions-empty p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.versions-enable { width: auto; }
.versions-header { display: flex; align-items: center; gap: 6px; margin: 12px 0 4px; }
.versions-save { height: 25px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 9px; background: transparent; color: var(--text); display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 600; }
.versions-save:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 32%, var(--line-strong)); }
.versions-save-form { display: flex; flex: 1; align-items: center; gap: 6px; }
.versions-save-input { flex: 1; min-width: 0; height: 25px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 8px; background: var(--bg); color: var(--text); font-size: 11px; }
.versions-save-input:focus { border-color: var(--accent); outline: none; }
.versions-refresh { width: 26px; height: 26px; margin-left: auto; border-radius: 7px; background: transparent; display: grid; place-items: center; color: var(--muted); }
.versions-refresh:hover { background: var(--line); color: var(--text); }
.versions-save-form .versions-refresh { margin-left: 0; }
.versions-list { margin-top: 8px; display: flex; flex-direction: column; }
.versions-entry { border-top: 1px solid var(--line); padding: 8px 0; }
.versions-entry:first-child { border-top: 0; }
.versions-entry-head { width: 100%; background: transparent; padding: 2px 0; text-align: left; display: grid; gap: 4px; cursor: pointer; }
.versions-entry-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.versions-author { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 700; }
.versions-time { color: var(--faint); font-size: 10px; }
.versions-count { margin-left: auto; color: var(--faint); font-size: 10px; }
.versions-entry-message { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.versions-entry-body { display: grid; gap: 6px; margin-top: 6px; }
.versions-files { display: grid; gap: 2px; }
.versions-file { display: flex; align-items: center; gap: 6px; min-height: 24px; border-radius: 6px; padding: 2px 6px; background: transparent; color: var(--muted); font-size: 10.5px; text-align: left; }
.versions-file:hover { background: var(--line); color: var(--text); }
.versions-file.active { background: var(--accent-soft); color: var(--accent); }
.versions-file > span { overflow-wrap: anywhere; }
.versions-kind { flex: none; }
.versions-kind.added { color: var(--success); }
.versions-kind.deleted { color: var(--danger); }
.versions-kind.renamed { color: var(--accent); }
.versions-kind.modified { color: var(--muted); }
.versions-file.active .versions-kind { color: inherit; }
.versions-binary { margin: 0; padding: 8px; font-size: 10.5px; color: var(--muted); }
.versions-restore-file { flex: none; height: 20px; border: 1px solid var(--line-strong); border-radius: 6px; padding: 0 7px; background: transparent; color: var(--text); display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; font-weight: 600; }
.versions-restore-file:hover:not(:disabled) { border-color: color-mix(in srgb, var(--danger) 40%, var(--line-strong)); color: var(--danger); }
.versions-restore-project { justify-self: start; height: 24px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 9px; background: transparent; color: var(--muted); display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; }
.versions-restore-project:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line-strong)); }
`;
