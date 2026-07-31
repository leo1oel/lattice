/**
 * Overleaf-style git "Versions" timeline for the history drawer, plus the
 * shared Pierre diff renderer (`HistoryDiff`) that both the Changes tab and
 * the Versions tab use. The renderer lives here (not in history-drawer.tsx)
 * so the drawer can import it without creating an import cycle.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FilePen,
  FilePlus2,
  FileX2,
  GitBranch,
  MoveRight,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import type { GitFileDiff, GitLogEntry, GitLogFileKind, GitStatus } from "./app-types";
import { peerColorForName } from "./collab-colors";
import { confirmAction, relativeTime } from "./app-utils";
import { changeKind } from "./history-diff";
import { FileDiffView } from "./file-diff-view";
import {
  InfinityLoader,
  ReloadButton,
  ReloadIconButton,
} from "./components/ui/activity-icons";
import { Input } from "./components/ui/input";

export type DiffFileChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function HistoryDiff(props: {
  change: DiffFileChange;
  onOpenLine?: (path: string, line: number) => void;
  headerAction?: ReactNode;
}) {
  const kind = changeKind(props.change.before, props.change.after);

  return (
    <div className="history-diff">
      <div className="history-diff-meta">
        <strong>{props.change.path}</strong>
        <span>{kind}</span>
        {props.headerAction}
      </div>
      <div className="lattice-file-diff-body" aria-label={`Diff for ${props.change.path}`}>
        <FileDiffView change={props.change} onOpenLine={props.onOpenLine} />
      </div>
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
  const [refreshing, setRefreshing] = useState(false);
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
    setRefreshing(true);
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
    } finally {
      setRefreshing(false);
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
    // The row is a toggle: clicking the open file closes it again, which is
    // what a row that stays highlighted while open leads you to expect.
    if (activeFile?.hash === hash && activeFile.path === path) {
      setActiveFile(null);
      setDiff(null);
      setDiffError("");
      return;
    }
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
    if (!await confirmAction(`Restore ${path} to this version? Your current file will be overwritten.`)) return;
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
    if (!await confirmAction(warning)) return;
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
    return <p className="versions-loading"><InfinityLoader size={13} /> Loading versions…</p>;
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
        <p className="versions-error" role="alert">Version history is unavailable: {error}</p>
        <ReloadButton
          className="versions-save"
          busy={refreshing}
          disabled={refreshing}
          onClick={() => void load()}
        >
          Try again
        </ReloadButton>
      </div>
    );
  }
  if (phase === "no-repo") {
    return (
      <div className="versions-empty">
        <p>Track versions of this project to see who changed what and roll back safely.</p>
        {error && <p className="versions-error" role="alert">{error}</p>}
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
    if (diffError) return <p className="history-diff-error" role="alert">{diffError}</p>;
    if (!diff) return <p className="history-diff-loading"><InfinityLoader size={12} /> Loading diff…</p>;
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
            <Input
              className="versions-save-input"
              controlSize="compact"
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
            <ReloadIconButton
              className="versions-refresh"
              label="Refresh versions"
              tooltip="Refresh versions"
              busy={refreshing}
              disabled={refreshing || busy}
              onClick={() => void load()}
              iconSize={13}
            />
          </>
        )}
      </div>
      {error && <p className="versions-error" role="alert">{error}</p>}
      {notice && <p className="versions-notice" role="status">{notice}</p>}
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
/* The accent rule is the sliding indicator, not a static border. */
.versions-tab.active { color: var(--text); }
.versions-loading, .versions-note { margin: 14px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.versions-loading { display: flex; align-items: center; gap: 6px; }
.versions-error { margin: 8px 0 0; color: var(--danger); font-size: 10px; }
.versions-notice { margin: 8px 0 0; color: var(--success); font-size: 10px; }
.versions-empty { margin-top: 14px; display: grid; gap: 10px; justify-items: start; }
.versions-empty p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.versions-enable { width: auto; }
.versions-header { display: flex; align-items: center; gap: 6px; margin: 12px 0 4px; }
.versions-save { height: 25px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 9px; background: transparent; color: var(--text); display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 600; }
.versions-save:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 32%, var(--line-strong)); }
.versions-save-form { display: flex; flex: 1; align-items: center; gap: 6px; }
.versions-save-input { flex: 1; min-width: 0; height: 25px; border-color: var(--field-control-border-color); border-radius: var(--field-control-radius); padding: 0 var(--field-control-padding-inline); background: var(--field-control-background); color: var(--text); font-size: 11px; }
.versions-save-input:focus { border-color: var(--field-control-interactive-border-color); outline: none; box-shadow: none; }
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
