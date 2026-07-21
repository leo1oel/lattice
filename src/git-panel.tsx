import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CloudDownload,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { changeKind, hunkedDiffLines, jumpLineForDiff } from "./history-diff";

export type GitFileStatus = {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
};

export type GitStatus = {
  available: boolean;
  repository: boolean;
  branch: string | null;
  remote?: string | null;
  remoteUrl?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
};

type GitRemoteResult = {
  summary: string;
  status: GitStatus;
};

type GitDiff = {
  path: string;
  staged: boolean;
  before?: string | null;
  after?: string | null;
};

export type CheckKey = `${"s" | "u"}:${string}`;

export function checkKey(path: string, staged: boolean): CheckKey {
  return `${staged ? "s" : "u"}:${path}`;
}

export function pathFromCheckKey(key: CheckKey): string {
  return key.slice(2);
}

export function selectionForSection(
  files: GitFileStatus[],
  staged: boolean,
  checked: Set<CheckKey>,
): { all: boolean; some: boolean; keys: CheckKey[] } {
  const keys = files.map((file) => checkKey(file.path, staged));
  const selected = keys.filter((key) => checked.has(key));
  return {
    all: keys.length > 0 && selected.length === keys.length,
    some: selected.length > 0 && selected.length < keys.length,
    keys,
  };
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function statusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "conflict":
      return "U";
    case "untracked":
      return "?";
    default:
      return "M";
  }
}

function GitDiffView(props: {
  path: string;
  before: string | null | undefined;
  after: string | null | undefined;
  onOpenLine: (path: string, line: number) => void;
}) {
  const kind = changeKind(props.before, props.after);
  const lines = useMemo(
    () => hunkedDiffLines(props.before, props.after, 3),
    [props.after, props.before],
  );
  return (
    <div className="history-diff">
      <div className="history-diff-meta">
        <strong>{props.path}</strong>
        <span>{kind}</span>
      </div>
      <pre className="history-diff-body git-diff-body" aria-label={`Diff for ${props.path}`}>
        {lines.map((line, index) => {
          if (line.type === "skip") {
            return (
              <code key={`skip-${index}`} className="history-diff-line skip">
                ⋯ {line.text}
              </code>
            );
          }
          const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const jumpLine = jumpLineForDiff(line);
          const clickable = jumpLine != null;
          return (
            <code
              key={`${line.type}-${index}`}
              className={`history-diff-line ${line.type}${clickable ? " clickable" : ""}`}
              onClick={() => {
                if (jumpLine != null) props.onOpenLine(props.path, jumpLine);
              }}
              title={clickable ? `Open ${props.path}:${jumpLine}` : undefined}
            >
              {`${prefix} ${line.text}`}
            </code>
          );
        })}
      </pre>
    </div>
  );
}

export function GitPanel(props: {
  onClose: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [checked, setChecked] = useState<Set<CheckKey>>(new Set());
  const [messageText, setMessageText] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await invoke<GitStatus>("git_status");
      setStatus(next);
      setRemoteUrl((current) => (current.trim() ? current : (next.remoteUrl ?? "")));
      setChecked((current) => {
        const alive = new Set<CheckKey>();
        for (const file of next.files) {
          if (file.staged) alive.add(checkKey(file.path, true));
          if (file.unstaged || file.status === "untracked") alive.add(checkKey(file.path, false));
        }
        return new Set([...current].filter((key) => alive.has(key)));
      });
      setSelected((current) => {
        if (!current) return null;
        const stillThere = next.files.some((file) => (
          file.path === current.path
          && (current.staged ? file.staged : file.unstaged || file.status === "untracked")
        ));
        return stillThere ? current : null;
      });
    } catch (reason) {
      setError(message(reason));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    void invoke<GitDiff>("git_diff", { path: selected.path, staged: selected.staged })
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const stagedFiles = status?.files.filter((file) => file.staged) ?? [];
  const unstagedFiles = status?.files.filter((file) => file.unstaged || file.status === "untracked") ?? [];
  const stagedSelection = selectionForSection(stagedFiles, true, checked);
  const unstagedSelection = selectionForSection(unstagedFiles, false, checked);
  const stagedCheckedPaths = stagedSelection.keys
    .filter((key) => checked.has(key))
    .map(pathFromCheckKey);
  const unstagedCheckedPaths = unstagedSelection.keys
    .filter((key) => checked.has(key))
    .map(pathFromCheckKey);

  const toggleChecked = (key: CheckKey) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setSectionChecked = (keys: CheckKey[], selectAll: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (selectAll) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const runMutation = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const renderFileList = (files: GitFileStatus[], staged: boolean, empty: string) => {
    if (!files.length) {
      return <p className="git-empty">{empty}</p>;
    }
    return (
      <div className="git-file-list">
        {files.map((file) => {
          const key = checkKey(file.path, staged);
          const active = selected?.path === file.path && selected.staged === staged;
          return (
            <div className={`git-file-row ${active ? "active" : ""}`} key={key}>
              <label className="git-file-check">
                <input
                  type="checkbox"
                  checked={checked.has(key)}
                  onChange={() => toggleChecked(key)}
                />
                <span className={`git-status-code ${file.status}`}>{statusLabel(file.status)}</span>
                <button
                  type="button"
                  className="git-file-path"
                  onClick={() => setSelected({ path: file.path, staged })}
                >
                  {file.path}
                </button>
              </label>
              <div className="git-file-actions">
                {staged ? (
                  <button
                    type="button"
                    title="Unstage"
                    disabled={busy}
                    onClick={() => void runMutation(async () => {
                      await invoke("git_unstage", { paths: [file.path] });
                    })}
                  >
                    <Minus size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    title="Stage"
                    disabled={busy}
                    onClick={() => void runMutation(async () => {
                      await invoke("git_stage", { paths: [file.path] });
                    })}
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer git-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <GitBranch size={16} />
            <span>Git</span>
            {status?.branch && <em className="git-branch-pill">{status.branch}</em>}
          </div>
          <div className="git-header-actions">
            <button type="button" title="Refresh" disabled={loading || busy} onClick={() => void refresh()}>
              {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            </button>
            <button type="button" onClick={props.onClose}><X size={16} /></button>
          </div>
        </div>
        <p className="drawer-copy">
          Stage, commit, and sync with the configured remote. Auth uses your system Git credentials (SSH agent or credential helper).
        </p>

        {error && <p className="history-diff-error">{error}</p>}
        {notice && <p className="git-notice">{notice}</p>}

        {status && !status.available && (
          <p className="empty-history">git is not installed or not on PATH. Install Git to use this panel.</p>
        )}
        {status?.available && !status.repository && (
          <div className="git-init-block">
            <p className="empty-history">This project folder is not a Git repository.</p>
            <button
              type="button"
              className="git-commit-button"
              disabled={busy}
              onClick={() => void runMutation(async () => {
                await invoke("git_init");
                setNotice("Initialized a new Git repository.");
              })}
            >
              <GitBranch size={13} /> Initialize repository
            </button>
          </div>
        )}

        {status?.repository && (
          <>
            <section className="git-section">
              <div className="git-section-header">
                <strong>Remote</strong>
                <span>
                  {status.upstream
                    ? `${status.upstream}${status.ahead || status.behind ? ` · ↑${status.ahead ?? 0} ↓${status.behind ?? 0}` : ""}`
                    : status.remote || "no remote"}
                </span>
              </div>
              <div className="git-remote-row">
                <input
                  type="url"
                  className="git-remote-input"
                  placeholder="https://github.com/you/paper.git or git@…"
                  value={remoteUrl}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy || !remoteUrl.trim()}
                  onClick={() => void runMutation(async () => {
                    const next = await invoke<GitStatus>("git_set_remote", {
                      name: "origin",
                      url: remoteUrl.trim(),
                    });
                    setStatus(next);
                    setRemoteUrl(next.remoteUrl ?? remoteUrl.trim());
                    setNotice(`Remote ${next.remote ?? "origin"} saved.`);
                  })}
                >
                  Save
                </button>
              </div>
              <div className="git-bulk-actions">
                <button
                  type="button"
                  disabled={busy || !status.remoteUrl}
                  onClick={() => void runMutation(async () => {
                    const result = await invoke<GitRemoteResult>("git_fetch");
                    setStatus(result.status);
                    setNotice(result.summary);
                  })}
                >
                  <CloudDownload size={12} /> Fetch
                </button>
                <button
                  type="button"
                  disabled={busy || !status.remoteUrl}
                  onClick={() => void runMutation(async () => {
                    const result = await invoke<GitRemoteResult>("git_pull");
                    setStatus(result.status);
                    setNotice(result.summary);
                  })}
                >
                  <ArrowDownToLine size={12} /> Pull
                </button>
                <button
                  type="button"
                  disabled={busy || !status.remoteUrl || !status.branch}
                  onClick={() => void runMutation(async () => {
                    const result = await invoke<GitRemoteResult>("git_push");
                    setStatus(result.status);
                    setNotice(result.summary);
                  })}
                >
                  <ArrowUpFromLine size={12} /> Push
                  {(status.ahead ?? 0) > 0 ? ` ${status.ahead}` : ""}
                </button>
              </div>
            </section>

            <section className="git-section">
              <div className="git-section-header">
                <label className="git-section-select">
                  <input
                    type="checkbox"
                    aria-label="Select all staged files"
                    disabled={!stagedFiles.length || busy}
                    checked={stagedSelection.all}
                    ref={(node) => {
                      if (node) node.indeterminate = stagedSelection.some;
                    }}
                    onChange={() => setSectionChecked(stagedSelection.keys, !stagedSelection.all)}
                  />
                  <strong>Staged</strong>
                </label>
                <span>{stagedFiles.length}</span>
              </div>
              {renderFileList(stagedFiles, true, "No staged changes.")}
              <div className="git-bulk-actions">
                <button
                  type="button"
                  disabled={busy || !stagedFiles.length}
                  onClick={() => void runMutation(async () => {
                    await invoke("git_unstage", { paths: stagedFiles.map((file) => file.path) });
                    setChecked((current) => {
                      const next = new Set(current);
                      for (const key of stagedSelection.keys) next.delete(key);
                      return next;
                    });
                  })}
                >
                  <Minus size={12} /> Unstage all
                </button>
                <button
                  type="button"
                  disabled={busy || !stagedCheckedPaths.length}
                  onClick={() => void runMutation(async () => {
                    await invoke("git_unstage", { paths: stagedCheckedPaths });
                    setChecked((current) => {
                      const next = new Set(current);
                      for (const key of stagedSelection.keys) {
                        if (stagedCheckedPaths.includes(pathFromCheckKey(key))) next.delete(key);
                      }
                      return next;
                    });
                  })}
                >
                  <Minus size={12} /> Unstage selected
                </button>
              </div>
            </section>

            <section className="git-section">
              <div className="git-section-header">
                <label className="git-section-select">
                  <input
                    type="checkbox"
                    aria-label="Select all changes"
                    disabled={!unstagedFiles.length || busy}
                    checked={unstagedSelection.all}
                    ref={(node) => {
                      if (node) node.indeterminate = unstagedSelection.some;
                    }}
                    onChange={() => setSectionChecked(unstagedSelection.keys, !unstagedSelection.all)}
                  />
                  <strong>Changes</strong>
                </label>
                <span>{unstagedFiles.length}</span>
              </div>
              {renderFileList(unstagedFiles, false, "Working tree clean.")}
              <div className="git-bulk-actions">
                <button
                  type="button"
                  disabled={busy || !unstagedFiles.length}
                  onClick={() => void runMutation(async () => {
                    await invoke("git_stage", { paths: unstagedFiles.map((file) => file.path) });
                    setChecked((current) => {
                      const next = new Set(current);
                      for (const key of unstagedSelection.keys) next.delete(key);
                      return next;
                    });
                  })}
                >
                  <Plus size={12} /> Stage all
                </button>
                <button
                  type="button"
                  disabled={busy || !unstagedCheckedPaths.length}
                  onClick={() => void runMutation(async () => {
                    await invoke("git_stage", { paths: unstagedCheckedPaths });
                    setChecked((current) => {
                      const next = new Set(current);
                      for (const key of unstagedSelection.keys) {
                        if (unstagedCheckedPaths.includes(pathFromCheckKey(key))) next.delete(key);
                      }
                      return next;
                    });
                  })}
                >
                  <Plus size={12} /> Stage selected
                </button>
              </div>
            </section>

            <section className="git-section">
              <div className="git-section-header">
                <strong>Commit</strong>
              </div>
              <textarea
                className="git-commit-input"
                rows={3}
                placeholder="Commit message"
                value={messageText}
                onChange={(event) => setMessageText(event.target.value)}
              />
              <button
                type="button"
                className="git-commit-button"
                disabled={busy || !stagedFiles.length || !messageText.trim()}
                onClick={() => void runMutation(async () => {
                  const hash = await invoke<string>("git_commit", { message: messageText });
                  setMessageText("");
                  setNotice(`Committed ${hash}`);
                  setSelected(null);
                })}
              >
                <Check size={13} /> Commit {stagedFiles.length ? `${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}` : ""}
              </button>
            </section>

            {selected && (
              <section className="git-section">
                <div className="git-section-header">
                  <strong>{selected.staged ? "Staged diff" : "Unstaged diff"}</strong>
                  <button
                    type="button"
                    className="git-open-file"
                    onClick={() => props.onOpenFile(selected.path)}
                  >
                    Open file
                  </button>
                </div>
                {!diff && <p className="history-diff-loading">Loading diff…</p>}
                {diff && (
                  <GitDiffView
                    path={diff.path}
                    before={diff.before}
                    after={diff.after}
                    onOpenLine={(path, line) => {
                      props.onOpenFile(path, line);
                      props.onClose();
                    }}
                  />
                )}
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
