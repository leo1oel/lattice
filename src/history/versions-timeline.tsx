/**
 * Overleaf-style git "Versions" timeline for the history drawer.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GitBranch, RotateCcw, Save, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import type { GitFileDiff, GitLogEntry, GitLogFileKind, GitStatus } from "../app-types";
import { peerColorForName } from "../components/ui/collab-colors";
import { confirmAction, relativeTime, toMessage } from "../app-utils";
import { InlineMessage } from "../components/ui/inline-message";
import { logAction } from "../telemetry/app-notify";
import { InfinityLoader, ReloadButton, ReloadIconButton } from "../components/ui/activity-icons";
import { Input } from "../components/ui/input";
import { FileKindIcon, HistoryDiff } from "./file-diff-view";
import { useLatestLoad } from "./use-latest-load";
import { AUTO_COMMIT_MESSAGES, versionMessageLabel } from "./version-messages";

type Phase = "loading" | "unavailable" | "no-repo" | "ready" | "error";

export function VersionsTimeline(props: {
  /** Called after any restore or manual save so the app can reload files. */
  onVersionsChanged?: () => void | Promise<void>;
  projectRoot?: string;
  /** Called when the git backend itself is unreachable (`git_status` rejects). */
  onGitUnreachable?: () => void;
}) {
  const { t } = useLingui();
  // Git's own file-status words, shown on each row's tooltip. The kind itself
  // stays the discriminant `FileKindIcon` and the CSS switch on.
  const fileKindLabel: Record<GitLogFileKind, string> = {
    added: t`added`,
    deleted: t`deleted`,
    renamed: t`renamed`,
    modified: t`modified`,
  };
  const [phase, setPhase] = useState<Phase>("loading");
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<{ hash: string; path: string } | null>(null);
  const fileDiff = useLatestLoad<GitFileDiff>();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");

  const callbacksRef = useRef(props);
  useEffect(() => {
    callbacksRef.current = props;
  });
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setRefreshing(true);
    setError("");
    try {
      const status = await invoke<GitStatus>("git_status");
      if (seq !== loadSeq.current) return;
      if (!status.available || !status.repository) {
        setPhase(status.available ? "no-repo" : "unavailable");
        return;
      }
      try {
        const entries = await invoke<GitLogEntry[]>("git_log", { limit: 100 });
        if (seq !== loadSeq.current) return;
        setEntries(entries);
      } catch (reason) {
        if (seq !== loadSeq.current) return;
        setError(toMessage(reason));
      }
      setPhase("ready");
    } catch (reason) {
      if (seq !== loadSeq.current) return;
      // The `git_*` commands themselves are missing or broken (e.g. an older
      // backend build). Show the failure here and let the drawer fall back to
      // the Changes tab so it stays useful.
      setError(toMessage(reason));
      setPhase("error");
      callbacksRef.current.onGitUnreachable?.();
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const cancelLoad = () => { ++loadSeq.current; };
    void load();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => { void load(); };
    void listen<{ root: string }>("project-fs-changed", (event) => {
      if (disposed || (props.projectRoot && event.payload.root !== props.projectRoot)) return;
      refresh();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => { /* Browser previews have no native event bridge. */ });
    // Git commits can also arrive while the app is unfocused or its watcher
    // is unavailable. Only poll while this timeline is mounted.
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      cancelLoad();
      unlisten?.();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load, props.projectRoot]);

  /** Run one logged action, then reload the timeline; resolves to its success message. */
  const runAction = async (label: string, detail: string | undefined, action: () => Promise<string>) => {
    setBusy(true);
    const trace = logAction(t`Versions`, label, detail);
    try {
      const outcome = await action();
      await load();
      trace.ok(outcome);
    } catch (reason) {
      trace.fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const enableTracking = () => runAction(t`Start tracking versions`, undefined, async () => {
    await invoke<GitStatus>("git_init");
    return t`Now tracking versions of this project.`;
  });

  const submitSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return runAction(t`Save version`, saveLabel.trim() || undefined, async () => {
      const hash = await invoke<string | null>("git_auto_commit", {
        message: saveLabel.trim() || AUTO_COMMIT_MESSAGES.saved,
        author: null,
      });
      setSaveOpen(false);
      setSaveLabel("");
      if (hash) await callbacksRef.current.onVersionsChanged?.();
      return hash ? t`Version saved.` : t`No changes since the last version.`;
    });
  };

  const restoreFile = async (hash: string, path: string) => {
    if (!await confirmAction(t`Restore ${path} to this version? Your current file will be overwritten.`)) return;
    await runAction(t`Restore file`, `${path} @ ${hash}`, async () => {
      await invoke("git_restore_file", { rev: hash, path });
      await callbacksRef.current.onVersionsChanged?.();
      return t`Restored ${path}.`;
    });
  };

  const restoreProject = async (hash: string) => {
    const warning = t`Restore the project to this version?

Nothing is lost: the restore is saved as a new version`;
    if (!await confirmAction(warning)) return;
    await runAction(t`Restore project`, hash, async () => {
      await invoke<string>("git_restore_project", { rev: hash });
      await callbacksRef.current.onVersionsChanged?.();
      return t`Project restored.`;
    });
  };

  const toggleEntry = (hash: string) => {
    setActiveFile(null);
    fileDiff.clear();
    setExpandedHash((current) => (current === hash ? null : hash));
  };

  const openFileDiff = (hash: string, path: string) => {
    // The row is a toggle: clicking the open file closes it again, which is
    // what a row that stays highlighted while open leads you to expect.
    if (activeFile?.hash === hash && activeFile.path === path) {
      setActiveFile(null);
      fileDiff.clear();
      return;
    }
    setActiveFile({ hash, path });
    fileDiff.load(`${hash}:${path}`, () => invoke<GitFileDiff>("git_show_diff", { rev: hash, path }));
  };

  if (phase === "loading") {
    return <p className="versions-loading"><InfinityLoader size={13} /> {t`Loading versions…`}</p>;
  }
  if (phase === "unavailable") {
    return <p className="versions-note">{t`Version history needs Git, which isn’t available on this Mac`}</p>;
  }
  if (phase === "error") {
    return (
      <div className="versions-empty">
        <InlineMessage level="error" className="versions-inline">{t`Version history is unavailable: ${error}`}</InlineMessage>
        <ReloadButton className="versions-save" busy={refreshing} disabled={refreshing} onClick={() => void load()}>
          {t`Try again`}
        </ReloadButton>
      </div>
    );
  }
  if (phase === "no-repo") {
    return (
      <div className="versions-empty">
        {error && <InlineMessage level="error" className="versions-inline">{error}</InlineMessage>}
        <button
          type="button"
          className="git-commit-button versions-enable"
          disabled={busy}
          onClick={() => void enableTracking()}
        >
          <GitBranch size={13} /> {t`Enable version tracking`}
        </button>
      </div>
    );
  }

  const renderDiff = (target: { hash: string; path: string }) => {
    const diff = fileDiff.value;
    if (fileDiff.error) return <InlineMessage level="error">{fileDiff.error}</InlineMessage>;
    if (!diff) return <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>;
    return (
      <HistoryDiff
        key={`${target.hash}:${target.path}`}
        change={{ path: target.path, before: diff.before, after: diff.after }}
        binary={diff.binary}
        headerAction={(
          <button
            type="button"
            className="versions-restore-file"
            disabled={busy}
            title={t`Restore ${target.path} to this version`}
            onClick={() => void restoreFile(target.hash, target.path)}
          >
            <RotateCcw size={10} /> {t`Restore this file`}
          </button>
        )}
      />
    );
  };

  const closeSave = () => {
    setSaveOpen(false);
    setSaveLabel("");
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
              placeholder={t`Label this version (optional)`}
              aria-label={t`Version label`}
              value={saveLabel}
              onChange={(event) => setSaveLabel(event.target.value)}
            />
            <button type="submit" className="versions-save" disabled={busy}>
              <Save size={12} /> {t`Save`}
            </button>
            <button type="button" className="versions-refresh" title={t`Cancel`} onClick={closeSave}>
              <X size={13} />
            </button>
          </form>
        ) : (
          <>
            <button type="button" className="versions-save" disabled={busy} onClick={() => setSaveOpen(true)}>
              <Save size={12} /> {t`Save version`}
            </button>
            <ReloadIconButton
              className="versions-refresh"
              label={t`Refresh versions`}
              tooltip={t`Refresh versions`}
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
          {t`No versions yet`}
        </p>
      )}
      <div className="versions-list">
        {entries.map((entry) => {
          const expanded = expandedHash === entry.hash;
          const authorName = entry.authorName || t`Unknown`;
          const color = peerColorForName(authorName);
          return (
            <div className={`versions-entry ${expanded ? "expanded" : ""}`} key={entry.hash}>
              <button
                type="button"
                className="versions-entry-head"
                aria-expanded={expanded}
                onClick={() => toggleEntry(entry.hash)}
              >
                <span className="versions-entry-top">
                  <span className="versions-author" style={{ background: color.colorLight, color: color.color }}>
                    {authorName}
                  </span>
                  <span className="versions-time" title={new Date(entry.timestamp).toLocaleString()}>
                    {relativeTime(entry.timestamp)}
                  </span>
                  <span className="versions-count">
                    {entry.files.length === 1 ? t`${entry.files.length} file` : t`${entry.files.length} files`}
                  </span>
                </span>
                <span className="versions-entry-message">{versionMessageLabel(entry.message)}</span>
              </button>
              {expanded && (
                <div className="versions-entry-body">
                  <div className="versions-files">
                    {entry.files.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={`versions-file ${activeFile?.hash === entry.hash && activeFile.path === file.path ? "active" : ""}`}
                        title={`${fileKindLabel[file.kind]}: ${file.path}`}
                        onClick={() => openFileDiff(entry.hash, file.path)}
                      >
                        <FileKindIcon kind={file.kind} />
                        <span>{file.path}</span>
                      </button>
                    ))}
                  </div>
                  {activeFile?.hash === entry.hash && renderDiff(activeFile)}
                  <button
                    type="button"
                    className="versions-restore-project"
                    disabled={busy}
                    onClick={() => void restoreProject(entry.hash)}
                  >
                    <RotateCcw size={12} /> {t`Restore project to this version`}
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
.versions-kind.deleted, .versions-kind.removed { color: var(--status-danger); }
.versions-kind.renamed { color: var(--control-active); }
.versions-kind.modified, .versions-kind.edited { color: var(--text-secondary); }
.versions-file.active .versions-kind { color: inherit; }
.versions-binary { margin: 0; padding: var(--space-4); font-size: var(--type-caption-size); color: var(--text-secondary); }
.versions-restore-file { flex: none; height: 20px; border: 1px solid var(--border-strong); border-radius: 6px; padding: 0 var(--pad-inline-control-tight); background: transparent; color: var(--text-primary); display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--type-micro-size); font-weight: 600; }
.versions-restore-file:hover:not(:disabled) { border-color: color-mix(in srgb, var(--status-danger) 40%, var(--border-strong)); color: var(--status-danger); }
.versions-restore-project { justify-self: start; height: 24px; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0 var(--pad-inline-control); background: transparent; color: var(--text-secondary); display: inline-flex; align-items: center; gap: var(--gap-inline-tight); font-size: var(--type-micro-size); font-weight: 600; }
.versions-restore-project:hover:not(:disabled) { color: var(--status-danger); border-color: color-mix(in srgb, var(--status-danger) 40%, var(--border-strong)); }
`;
