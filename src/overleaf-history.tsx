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
  MoveRight,
  RotateCcw,
  Tag,
} from "lucide-react";
import { HistoryDiff } from "./versions-timeline";
import { Input } from "./components/ui/input";
import { useOverleafHistory } from "./use-overleaf-history";
import { changedFiles, isBinaryDiff, textFromDiffChunks } from "./overleaf-history-diff";
import type {
  OverleafDiffChunk,
  OverleafFileEntry,
  OverleafFileOperation,
  OverleafUpdate,
} from "./overleaf-history-types";
import { useLingui } from "@lingui/react/macro";
import { confirmAction } from "./app-utils";
import { peerColorForName } from "./collab-colors";
import { DestructiveButton } from "./components/ui/destructive-button";
import { InlineMessage } from "./components/ui/inline-message";
import { notifySuccess } from "./app-notify";
import { InfinityLoader } from "./components/ui/activity-icons";
import "./overleaf-history.css";

/** Notification source label for the Overleaf history drawer. */
const OVERLEAF_HISTORY_SOURCE = "Overleaf history";

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

function dayLabel(key: string, prose: { today: string; yesterday: string }): string {
  if (key === new Date().toDateString()) return prose.today;
  if (key === new Date(Date.now() - 86_400_000).toDateString()) return prose.yesterday;
  return key;
}

/**
 * Overleaf's editor leaves no origin (or "web"); anything else — an upload, a
 * Dropbox sync, the git bridge, a restore — is worth naming, so a change that
 * did not come from someone typing in the browser doesn't read as if it did.
 */
function originLabel(origin: string | null, known: Record<string, string>): string | null {
  if (!origin || origin === "web" || origin === "editor") return null;
  return known[origin] ?? origin;
}

function FileOpIcon(props: { op: OverleafFileEntry["operation"] }) {
  if (props.op === "added") return <FilePlus2 size={12} className="overleaf-history-kind added" aria-hidden />;
  if (props.op === "removed") return <FileX2 size={12} className="overleaf-history-kind removed" aria-hidden />;
  if (props.op === "renamed") return <MoveRight size={12} className="overleaf-history-kind renamed" aria-hidden />;
  return <FilePen size={12} className="overleaf-history-kind edited" aria-hidden />;
}

export function OverleafHistoryPanel(props: {
  /** The project this drawer was opened for; every request is scoped to it. */
  projectRoot: string;
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
  const { t } = useLingui();
  // Overleaf's own origin codes, translated here so the two helpers above stay
  // pure functions the day grouping can call outside a component.
  const originNames: Record<string, string> = {
    upload: t`file upload`,
    dropbox: "Dropbox",
    "git-bridge": t`git bridge`,
    "file-restore": t`file restore`,
    "project-restore": t`project restore`,
  };
  const dayProse = { today: t`Today`, yesterday: t`Yesterday` };
  const fileOpLabel: Record<OverleafFileOperation, string> = {
    added: t`added`,
    removed: t`removed`,
    renamed: t`renamed`,
    edited: t`edited`,
  };
  const history = useOverleafHistory(props.projectRoot);
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
      projectRoot: props.projectRoot,
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
      projectRoot: props.projectRoot,
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
    try {
      await action();
      notifySuccess(OVERLEAF_HISTORY_SOURCE, onOk);
    } catch {
      // Nothing further to do: history.error now holds the reason.
    }
  };

  return (
    <div className="overleaf-history-panel">
      <p className="drawer-copy">
        {t`Overleaf's own record of this project, including everything collaborators changed in the browser while Lattice was closed. Restoring here changes Overleaf's copy — sync afterward to bring the result into this app.`}
      </p>

      {history.error && <InlineMessage level="error" className="overleaf-history-inline">{history.error}</InlineMessage>}

      {history.loading && !history.updates.length && (
        <p className="overleaf-history-loading"><InfinityLoader size={13} /> {t`Loading Overleaf's history…`}</p>
      )}
      {!history.loading && !history.updates.length && !history.error && (
        <p className="overleaf-history-empty">{t`No history yet.`}</p>
      )}

      <div className="overleaf-history-list">
        {grouped.map(([key, dayUpdates]) => (
          <div className="overleaf-history-day" key={key}>
            <h3 className="overleaf-history-day-label">{dayLabel(key, dayProse)}</h3>
            {dayUpdates.map((update) => {
              const expandedHere = expanded === update.toVersion;
              const primaryAuthor = update.authors[0] ?? t`Unknown`;
              const color = peerColorForName(primaryAuthor);
              const extraAuthors = update.authors.length > 1 ? ` +${update.authors.length - 1}` : "";
              const origin = originLabel(update.origin, originNames);
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
                        {update.paths.length === 1
                          ? t`${update.paths.length} file`
                          : t`${update.paths.length} files`}
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
                                <DestructiveButton
                                  type="button"
                                  data-hit-area
                                  title={t`Remove the "${label.comment}" label`}
                                  disabled={history.busy}
                                  iconSize={10}
                                  onClick={async () => {
                                    if (!await confirmAction(
                                      t`Remove the “${label.comment}” label from this Overleaf version?`,
                                    )) {
                                      return;
                                    }
                                    void run(t`Label removed.`, () => history.deleteLabel(label.id));
                                  }}
                                />
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
                              void run(t`Version named.`, () => history.addLabel(update.toVersion, comment))
                                .then(() => {
                                  setLabelDraftFor(null);
                                  setLabelDraft("");
                                });
                            }}
                          >
                            <Input
                              controlSize="compact"
                              autoFocus
                              value={labelDraft}
                              placeholder={t`Name this version…`}
                              aria-label={t`Version label`}
                              onChange={(event) => setLabelDraft(event.target.value)}
                            />
                            <button type="submit" disabled={!labelDraft.trim() || history.busy}>{t`Save`}</button>
                            <button
                              type="button"
                              onClick={() => {
                                setLabelDraftFor(null);
                                setLabelDraft("");
                              }}
                            >
                              {t`Cancel`}
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
                            <Tag size={11} aria-hidden /> {t`Name this version`}
                          </button>
                        )}
                      </div>

                      {filesLoading && (
                        <p className="git-empty"><InfinityLoader size={12} /> {t`Loading files…`}</p>
                      )}
                      {filesError && <InlineMessage level="error" className="overleaf-history-inline">{filesError}</InlineMessage>}
                      {files && !files.length && !filesLoading && (
                        <p className="overleaf-history-note">{t`No file changes recorded for this update.`}</p>
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
                                  title={`${fileOpLabel[file.operation ?? "edited"]}: ${file.pathname}`}
                                  onClick={() => openDiff(update, file.newPathname ?? file.pathname)}
                                >
                                  <FileOpIcon op={file.operation} />
                                  <span>{label}</span>
                                </button>
                                {file.operation === "removed" && file.deletedAtV != null ? (
                                  <button
                                    type="button"
                                    className="overleaf-history-restore-file"
                                    title={t`Bring back ${file.pathname}`}
                                    disabled={history.busy}
                                    onClick={() => void run(
                                      t`Restored ${file.pathname}.`,
                                      () => history.restoreDeletedFile(file.deletedAtV!, file.pathname)
                                        .then(() => props.onRestored?.()),
                                    )}
                                  >
                                    <RotateCcw size={10} /> {t`Restore`}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="overleaf-history-restore-file"
                                    title={t`Restore ${file.pathname} to this version`}
                                    disabled={history.busy}
                                    onClick={() => void run(
                                      t`Restored ${file.pathname}.`,
                                      () => history.revertFile(update.toVersion, file.pathname)
                                        .then(() => props.onRestored?.()),
                                    )}
                                  >
                                    <RotateCcw size={10} /> {t`Restore this file`}
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
                            <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>
                          )}
                          {diffError && <p className="history-diff-error" role="alert">{diffError}</p>}
                          {diffBinary && (
                            <div className="history-diff">
                              <div className="history-diff-meta">
                                <strong>{activePath}</strong>
                                <span>{t`binary`}</span>
                              </div>
                              <p className="overleaf-history-binary">{t`Binary file changed.`}</p>
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
                        onClick={async () => {
                          const warning = t`Restore the whole project to this version? Files added since will be deleted, and everything else will be rewound to match. The only way back from here is another restore.`;
                          if (!await confirmAction(warning)) return;
                          void run(
                            t`Project restored.`,
                            () => history.revertProject(update.toVersion).then(() => props.onRestored?.()),
                          );
                        }}
                      >
                        <RotateCcw size={12} /> {t`Restore whole project to this version`}
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
          {history.loadingMore && <InfinityLoader size={12} />} {t`Load more`}
        </button>
      )}
    </div>
  );
}
