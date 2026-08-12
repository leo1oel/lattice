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
import { InlineMessage } from "./components/ui/inline-message";
import { logAction } from "./app-notify";
import { changeKind } from "./history-diff";

/** Notification source label for the version timeline. */
const VERSIONS_SOURCE = "Versions";
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
    const trace = logAction(VERSIONS_SOURCE, "Start tracking versions");
    try {
      await invoke<GitStatus>("git_init");
      await load();
      trace.ok("Now tracking versions of this project.");
    } catch (reason) {
      trace.fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const submitSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const trace = logAction(VERSIONS_SOURCE, "Save version", saveLabel.trim() || undefined);
    try {
      const hash = await invoke<string | null>("git_auto_commit", {
        message: saveLabel.trim() || "Saved version",
        author: null,
      });
      setSaveOpen(false);
      setSaveLabel("");
      trace.ok(hash ? "Version saved." : "No changes since the last version.");
      if (hash) callbacksRef.current.onVersionsChanged?.();
      await load();
    } catch (reason) {
      trace.fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const toggleEntry = (hash: string) => {
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
    const trace = logAction(VERSIONS_SOURCE, "Restore file", `${path} @ ${hash}`);
    try {
      await invoke("git_restore_file", { rev: hash, path });
      trace.ok(`Restored ${path}.`);
      callbacksRef.current.onVersionsChanged?.();
      await load();
    } catch (reason) {
      trace.fail(reason);
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
    const trace = logAction(VERSIONS_SOURCE, "Restore project", hash);
    try {
      await invoke<string>("git_restore_project", { rev: hash });
      trace.ok("Project restored.");
      callbacksRef.current.onVersionsChanged?.();
      await load();
    } catch (reason) {
      trace.fail(reason);
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
        <InlineMessage level="error" className="versions-inline">Version history is unavailable: {error}</InlineMessage>
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
        {error && <InlineMessage level="error" className="versions-inline">{error}</InlineMessage>}
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
    if (diffError) return <InlineMessage level="error">{diffError}</InlineMessage>;
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
              onClick={() => setSaveOpen(true)}
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
      {error && <InlineMessage level="error" className="versions-inline">{error}</InlineMessage>}
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
.versions-tabs { margin-top: var(--space-4); padding-bottom: var(--space-3); border-bottom: 1px solid var(--border-subtle); }
.versions-loading, .versions-note { margin: 14px 0 0; color: var(--text-secondary); font-size: var(--type-caption-size); line-height: 1.5; }
.versions-loading { display: flex; align-items: center; gap: var(--space-3); }
/* Appearance is owned by \`.ui-inline-message\`; only the spacing is local. */
.versions-inline { margin-top: var(--space-4); }
.versions-empty { margin-top: 14px; display: grid; gap: var(--space-5); justify-items: start; }
.versions-empty p { margin: 0; color: var(--text-secondary); font-size: var(--type-caption-size); line-height: 1.5; }
.versions-enable { width: auto; }
.versions-header { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-6) 0 var(--space-2); }
.versions-save { height: 25px; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0 var(--pad-inline-control); background: transparent; color: var(--text-primary); display: inline-flex; align-items: center; gap: var(--gap-inline-tight); font-size: var(--type-caption-size); font-weight: 600; }
.versions-save:hover:not(:disabled) { border-color: color-mix(in srgb, var(--control-active) 32%, var(--border-strong)); }
.versions-save-form { display: flex; flex: 1; align-items: center; gap: var(--space-3); }
.versions-save-input { flex: 1; min-width: 0; height: 25px; border-color: var(--field-control-border-color); border-radius: var(--field-control-radius); padding: 0 var(--field-control-padding-inline); background: var(--field-control-background); color: var(--text-primary); font-size: var(--type-caption-size); }
.versions-save-input:focus { border-color: var(--field-control-interactive-border-color); outline: none; box-shadow: none; }
.versions-refresh { width: 26px; height: 26px; margin-left: auto; border-radius: 7px; background: transparent; display: grid; place-items: center; color: var(--text-secondary); }
.versions-refresh:hover { background: var(--border-subtle); color: var(--text-primary); }
.versions-save-form .versions-refresh { margin-left: 0; }
.versions-list { margin-top: var(--space-4); display: flex; flex-direction: column; }
.versions-entry { border-top: 1px solid var(--border-subtle); padding: var(--space-4) 0; }
.versions-entry:first-child { border-top: 0; }
.versions-entry-head { width: 100%; background: transparent; padding: var(--space-1) 0; text-align: left; display: grid; gap: var(--space-2); cursor: pointer; }
.versions-entry-top { display: flex; align-items: center; gap: var(--gap-inline); min-width: 0; }
.versions-author { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 7px; border-radius: 999px; font-size: var(--type-micro-size); font-weight: 700; }
.versions-time { color: var(--text-tertiary); font-size: var(--type-micro-size); }
.versions-count { margin-left: auto; color: var(--text-tertiary); font-size: var(--type-micro-size); }
.versions-entry-message { margin: 0; font-size: var(--type-label-size); font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
.versions-entry-body { display: grid; gap: var(--space-3); margin-top: var(--space-3); }
.versions-files { display: grid; gap: var(--space-1); }
.versions-file { display: flex; align-items: center; gap: var(--space-3); min-height: 24px; border-radius: 6px; padding: var(--space-1) var(--space-3); background: transparent; color: var(--text-secondary); font-size: var(--type-caption-size); text-align: left; }
.versions-file:hover { background: var(--border-subtle); color: var(--text-primary); }
.versions-file.active { background: var(--control-active-soft); color: var(--control-active); }
.versions-file > span { overflow-wrap: anywhere; }
.versions-kind { flex: none; }
.versions-kind.added { color: var(--status-success); }
.versions-kind.deleted { color: var(--status-danger); }
.versions-kind.renamed { color: var(--control-active); }
.versions-kind.modified { color: var(--text-secondary); }
.versions-file.active .versions-kind { color: inherit; }
.versions-binary { margin: 0; padding: var(--space-4); font-size: var(--type-caption-size); color: var(--text-secondary); }
.versions-restore-file { flex: none; height: 20px; border: 1px solid var(--border-strong); border-radius: 6px; padding: 0 var(--pad-inline-control-tight); background: transparent; color: var(--text-primary); display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--type-micro-size); font-weight: 600; }
.versions-restore-file:hover:not(:disabled) { border-color: color-mix(in srgb, var(--status-danger) 40%, var(--border-strong)); color: var(--status-danger); }
.versions-restore-project { justify-self: start; height: 24px; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0 var(--pad-inline-control); background: transparent; color: var(--text-secondary); display: inline-flex; align-items: center; gap: var(--gap-inline-tight); font-size: var(--type-micro-size); font-weight: 600; }
.versions-restore-project:hover:not(:disabled) { color: var(--status-danger); border-color: color-mix(in srgb, var(--status-danger) 40%, var(--border-strong)); }
`;
