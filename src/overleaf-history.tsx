/**
 * Overleaf's own project history, browsed and restored from inside Lattice.
 *
 * This is the third tab of the Project history drawer, beside "Changes" and
 * the git-backed "Versions" timeline — one place to answer "where do I find an
 * older version of this", rather than a second history button in the toolbar
 * that people would have to guess between. What makes it a separate tab rather
 * than more rows in the existing ones is the source: Overleaf keeps its own
 * independent history on its servers, covering every edit a collaborator made
 * in the browser while Lattice was closed, and none of that is in local git.
 * Restoring through here rewrites files on Overleaf's server; it does not
 * touch the local project directly, so the caller is expected to sync
 * afterward (see `onRestored`).
 *
 * Reuses `HistoryDiff` from `versions-timeline.tsx` for the actual diff
 * rendering — via the adapter in `overleaf-history-diff.ts` — rather than
 * building a second hunk view for Overleaf's differently-shaped diff payload.
 */
import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FilePen,
  FilePlus2,
  FileX2,
  LoaderCircle,
  MoveRight,
  RotateCcw,
  Tag,
  X,
} from "lucide-react";
import { HistoryDiff } from "./versions-timeline";
import { useOverleafHistory } from "./use-overleaf-history";
import { changedFiles, isBinaryDiff, textFromDiffChunks } from "./overleaf-history-diff";
import type {
  OverleafDiffChunk,
  OverleafFileEntry,
  OverleafUpdate,
} from "./overleaf-history-types";
import { peerColorForName } from "./collab-colors";
import "./overleaf-history.css";

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The clock time an entry was made, which is what tells two of them apart.
 *
 * "3h ago" is fine for the newest thing in a list and useless for a history:
 * an afternoon's work is a dozen entries that all read "3h ago", and picking
 * the right one to restore means knowing which is which. The day is already
 * the heading above, so this is the time within it.
 */
function clockTime(ms: number): string {
  const when = new Date(ms);
  if (!Number.isFinite(when.getTime())) return "";
  return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayKey(ms: number): string {
  return new Date(ms).toDateString();
}

function dayLabel(key: string): string {
  if (key === new Date().toDateString()) return "Today";
  if (key === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return key;
}

/**
 * Overleaf's editor leaves no origin (or "web"); anything else — an upload, a
 * Dropbox sync, the git bridge, a restore — is worth naming, so a change that
 * did not come from someone typing in the browser doesn't read as if it did.
 */
function originLabel(origin: string | null): string | null {
  if (!origin || origin === "web" || origin === "editor") return null;
  const known: Record<string, string> = {
    upload: "file upload",
    dropbox: "Dropbox",
    "git-bridge": "git bridge",
    "file-restore": "file restore",
    "project-restore": "project restore",
  };
  return known[origin] ?? origin;
}

function FileOpIcon(props: { op: OverleafFileEntry["operation"] }) {
  if (props.op === "added") return <FilePlus2 size={12} className="overleaf-history-kind added" aria-hidden />;
  if (props.op === "removed") return <FileX2 size={12} className="overleaf-history-kind removed" aria-hidden />;
  if (props.op === "renamed") return <MoveRight size={12} className="overleaf-history-kind renamed" aria-hidden />;
  return <FilePen size={12} className="overleaf-history-kind edited" aria-hidden />;
}

export function OverleafHistoryPanel(props: {
  /** Close the whole drawer — jumping to a line from a diff gets out of the way. */
  onClose: () => void;
  /** Put the caret on a line from a rendered diff, the way the Changes/Versions tabs do. */
  onOpenFile?: (path: string, line?: number) => void;
  /**
   * Called after any successful restore. A restore only changes Overleaf's
   * copy of the project, so this is the caller's cue to sync and reload —
   * there is nothing this drawer can do to the local files itself.
   */
  onRestored?: () => void;
}) {
  const history = useOverleafHistory();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [files, setFiles] = useState<OverleafFileEntry[] | null>(null);
  const [filesError, setFilesError] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [diffChunks, setDiffChunks] = useState<OverleafDiffChunk[] | null>(null);
  const [diffBinary, setDiffBinary] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [labelDraftFor, setLabelDraftFor] = useState<number | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [notice, setNotice] = useState("");

  const filesSeq = useRef(0);
  const diffSeq = useRef(0);

  const grouped = useMemo(() => {
    const groups = new Map<string, OverleafUpdate[]>();
    for (const update of history.updates) {
      const key = dayKey(update.endTs);
      const bucket = groups.get(key);
      if (bucket) bucket.push(update);
      else groups.set(key, [update]);
    }
    return [...groups.entries()];
  }, [history.updates]);

  const toggleEntry = (update: OverleafUpdate) => {
    setNotice("");
    setActivePath(null);
    setDiffChunks(null);
    setDiffBinary(false);
    setDiffError("");
    setLabelDraftFor(null);
    if (expanded === update.toVersion) {
      setExpanded(null);
      setFiles(null);
      return;
    }
    setExpanded(update.toVersion);
    setFiles(null);
    setFilesError("");
    setFilesLoading(true);
    const seq = (filesSeq.current += 1);
    void invoke<{ diff: OverleafFileEntry[] }>("overleaf_history_files", {
      from: update.fromVersion,
      to: update.toVersion,
    })
      .then((result) => {
        if (filesSeq.current !== seq) return;
        setFiles(changedFiles(result.diff));
      })
      .catch((reason) => {
        if (filesSeq.current !== seq) return;
        setFilesError(message(reason));
      })
      .finally(() => {
        if (filesSeq.current === seq) setFilesLoading(false);
      });
  };

  const openDiff = (update: OverleafUpdate, path: string) => {
    // The row is a toggle: clicking the open file closes it again, which is
    // what a row that stays highlighted while open leads you to expect.
    if (activePath === path) {
      setActivePath(null);
      setDiffChunks(null);
      setDiffBinary(false);
      setDiffError("");
      setDiffLoading(false);
      return;
    }
    setActivePath(path);
    setDiffChunks(null);
    setDiffBinary(false);
    setDiffError("");
    setDiffLoading(true);
    const seq = (diffSeq.current += 1);
    void invoke<{ diff: OverleafDiffChunk[] | { binary: true } }>("overleaf_history_diff", {
      path,
      from: update.fromVersion,
      to: update.toVersion,
    })
      .then((result) => {
        if (diffSeq.current !== seq) return;
        if (isBinaryDiff(result.diff)) setDiffBinary(true);
        else setDiffChunks(result.diff);
      })
      .catch((reason) => {
        if (diffSeq.current !== seq) return;
        setDiffError(message(reason));
      })
      .finally(() => {
        if (diffSeq.current === seq) setDiffLoading(false);
      });
  };

  /** Run a restore/label action, showing what happened and swallowing the
   *  error here — the hook already surfaces it above the list. */
  const run = async (onOk: string, action: () => Promise<void>) => {
    setNotice("");
    try {
      await action();
      setNotice(onOk);
    } catch {
      // Nothing further to do: history.error now holds the reason.
    }
  };

  return (
    <div className="overleaf-history-panel">
      <p className="drawer-copy">
        Overleaf's own record of this project, including everything collaborators changed in the
        browser while Lattice was closed. Restoring here changes Overleaf's copy — sync afterward
        to bring the result into this app.
      </p>

      {history.error && <p className="overleaf-history-error">{history.error}</p>}
      {notice && <p className="overleaf-history-notice">{notice}</p>}

      {history.loading && !history.updates.length && (
        <p className="overleaf-history-loading">Loading Overleaf's history…</p>
      )}
      {!history.loading && !history.updates.length && !history.error && (
        <p className="overleaf-history-empty">No history yet.</p>
      )}

      <div className="overleaf-history-list">
        {grouped.map(([key, dayUpdates]) => (
          <div className="overleaf-history-day" key={key}>
            <h3 className="overleaf-history-day-label">{dayLabel(key)}</h3>
            {dayUpdates.map((update) => {
              const expandedHere = expanded === update.toVersion;
              const primaryAuthor = update.authors[0] ?? "Unknown";
              const color = peerColorForName(primaryAuthor);
              const extraAuthors = update.authors.length > 1 ? ` +${update.authors.length - 1}` : "";
              const origin = originLabel(update.origin);
              return (
                <div className={`overleaf-history-entry ${expandedHere ? "expanded" : ""}`} key={update.toVersion}>
                  <button
                    type="button"
                    className="overleaf-history-entry-head"
                    aria-expanded={expandedHere}
                    onClick={() => toggleEntry(update)}
                  >
                    <span className="overleaf-history-entry-top">
                      <span
                        className="overleaf-history-author"
                        style={{ background: color.colorLight, color: color.color }}
                      >
                        {primaryAuthor}{extraAuthors}
                      </span>
                      <span className="overleaf-history-time" title={new Date(update.endTs).toLocaleString()}>
                        {clockTime(update.endTs)}
                      </span>
                      <span className="overleaf-history-count">
                        {update.paths.length} file{update.paths.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    {(origin || update.labels.length > 0) && (
                      <span className="overleaf-history-entry-meta">
                        {origin && <span className="overleaf-history-origin">{origin}</span>}
                        {update.labels.map((label) => (
                          <span className="overleaf-history-label" key={label.id}>
                            <Tag size={9} aria-hidden /> {label.comment}
                          </span>
                        ))}
                      </span>
                    )}
                    {update.paths.length > 0 && (
                      <p className="overleaf-history-paths">{update.paths.join(", ")}</p>
                    )}
                  </button>

                  {expandedHere && (
                    <div className="overleaf-history-entry-body">
                      <div className="overleaf-history-labels-row">
                        {update.labels.length > 0 && (
                          <div className="overleaf-history-labels">
                            {update.labels.map((label) => (
                              <span className="overleaf-history-label-chip" key={label.id}>
                                <Tag size={10} aria-hidden /> {label.comment}
                                <button
                                  type="button"
                                  title={`Remove the "${label.comment}" label`}
                                  disabled={history.busy}
                                  onClick={() => void run("Label removed.", () => history.deleteLabel(label.id))}
                                >
                                  <X size={10} />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        {labelDraftFor === update.toVersion ? (
                          <form
                            className="overleaf-history-label-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const comment = labelDraft.trim();
                              if (!comment) return;
                              void run("Version named.", () => history.addLabel(update.toVersion, comment))
                                .then(() => {
                                  setLabelDraftFor(null);
                                  setLabelDraft("");
                                });
                            }}
                          >
                            <input
                              autoFocus
                              value={labelDraft}
                              placeholder="Name this version…"
                              aria-label="Version label"
                              onChange={(event) => setLabelDraft(event.target.value)}
                            />
                            <button type="submit" disabled={!labelDraft.trim() || history.busy}>Save</button>
                            <button
                              type="button"
                              onClick={() => {
                                setLabelDraftFor(null);
                                setLabelDraft("");
                              }}
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="overleaf-history-name-version"
                            onClick={() => {
                              setLabelDraftFor(update.toVersion);
                              setLabelDraft("");
                            }}
                          >
                            <Tag size={11} aria-hidden /> Name this version
                          </button>
                        )}
                      </div>

                      {filesLoading && (
                        <p className="git-empty"><LoaderCircle className="spin" size={12} /> Loading files…</p>
                      )}
                      {filesError && <p className="overleaf-history-error">{filesError}</p>}
                      {files && !files.length && !filesLoading && (
                        <p className="overleaf-history-note">No file changes recorded for this update.</p>
                      )}
                      {files && files.length > 0 && (
                        <div className="overleaf-history-files">
                          {files.map((file) => {
                            const active = activePath === file.pathname || activePath === file.newPathname;
                            const label = file.operation === "renamed" && file.newPathname
                              ? `${file.pathname} → ${file.newPathname}`
                              : file.pathname;
                            return (
                              <div className="overleaf-history-file-row" key={file.pathname}>
                                <button
                                  type="button"
                                  className={`overleaf-history-file ${active ? "active" : ""}`}
                                  title={`${file.operation}: ${file.pathname}`}
                                  onClick={() => openDiff(update, file.newPathname ?? file.pathname)}
                                >
                                  <FileOpIcon op={file.operation} />
                                  <span>{label}</span>
                                </button>
                                {file.operation === "removed" && file.deletedAtV != null ? (
                                  <button
                                    type="button"
                                    className="overleaf-history-restore-file"
                                    title={`Bring back ${file.pathname}`}
                                    disabled={history.busy}
                                    onClick={() => void run(
                                      `Restored ${file.pathname}.`,
                                      () => history.restoreDeletedFile(file.deletedAtV!, file.pathname)
                                        .then(() => props.onRestored?.()),
                                    )}
                                  >
                                    <RotateCcw size={10} /> Restore
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="overleaf-history-restore-file"
                                    title={`Restore ${file.pathname} to this version`}
                                    disabled={history.busy}
                                    onClick={() => void run(
                                      `Restored ${file.pathname}.`,
                                      () => history.revertFile(update.toVersion, file.pathname)
                                        .then(() => props.onRestored?.()),
                                    )}
                                  >
                                    <RotateCcw size={10} /> Restore this file
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {activePath && (
                        <>
                          {diffLoading && !diffChunks && !diffBinary && (
                            <p className="history-diff-loading">Loading diff…</p>
                          )}
                          {diffError && <p className="history-diff-error">{diffError}</p>}
                          {diffBinary && (
                            <div className="history-diff">
                              <div className="history-diff-meta">
                                <strong>{activePath}</strong>
                                <span>binary</span>
                              </div>
                              <p className="overleaf-history-binary">Binary file changed.</p>
                            </div>
                          )}
                          {diffChunks && (
                            <HistoryDiff
                              key={`${update.toVersion}:${activePath}`}
                              change={textFromDiffChunks(activePath, diffChunks)}
                              onOpenLine={props.onOpenFile
                                ? (path, line) => {
                                    props.onOpenFile?.(path, line);
                                    props.onClose();
                                  }
                                : undefined}
                            />
                          )}
                        </>
                      )}

                      <button
                        type="button"
                        className="overleaf-history-restore-project"
                        disabled={history.busy}
                        onClick={() => {
                          const warning = "Restore the whole project to this version? "
                            + "Files added since will be deleted, and everything else will be rewound "
                            + "to match. The only way back from here is another restore.";
                          if (!window.confirm(warning)) return;
                          void run(
                            "Project restored.",
                            () => history.revertProject(update.toVersion).then(() => props.onRestored?.()),
                          );
                        }}
                      >
                        <RotateCcw size={12} /> Restore whole project to this version
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {history.hasMore && (
        <button
          type="button"
          className="overleaf-history-load-more"
          disabled={history.loadingMore}
          onClick={() => void history.loadMore()}
        >
          {history.loadingMore && <LoaderCircle className="spin" size={12} />} Load more
        </button>
      )}
    </div>
  );
}
