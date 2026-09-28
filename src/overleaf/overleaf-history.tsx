/**
 * Overleaf's own project history, browsed and restored from inside Lattice.
 *
 * This is the third tab of the Project history drawer, beside "Changes" and
 * the git-backed "Versions" timeline — one place to answer "where do I find an
 * older version of this". It is a separate tab because the source is: Overleaf
 * keeps its own history on its servers, covering every edit a collaborator
 * made in the browser while Lattice was closed, and none of that is in local
 * git. Restoring rewrites Overleaf's copy, not the local files, so the caller
 * is expected to sync afterward (see `onRestored`). It borrows the Versions
 * timeline's row styling and its diff renderer rather than growing a second one.
 */
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, Tag } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { FileKindIcon, HistoryDiff } from "../history/file-diff-view";
import { useLatestLoad } from "../history/use-latest-load";
import { Input } from "../components/ui/input";
import { confirmAction } from "../app-utils";
import { peerColorForName } from "../components/ui/collab-colors";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InlineMessage } from "../components/ui/inline-message";
import { notifySuccess } from "../telemetry/app-notify";
import { InfinityLoader } from "../components/ui/activity-icons";
import { textFromDiffChunks, useOverleafHistory } from "./use-overleaf-history";
import type { OverleafDiffChunk, OverleafFileEntry, OverleafFileOperation, OverleafUpdate } from "./use-overleaf-history";
import "./overleaf-history.css";

/** Notification source label for the Overleaf history drawer. */
const OVERLEAF_HISTORY_SOURCE = "Overleaf history";

/**
 * The clock time an entry was made, which is what tells two of them apart:
 * an afternoon's work is a dozen entries that would all read "3h ago", and the
 * day is already the heading above.
 */
function clockTime(ms: number): string {
  const when = new Date(ms);
  return Number.isFinite(when.getTime()) ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

function dayLabel(key: string, prose: { today: string; yesterday: string }): string {
  if (key === new Date().toDateString()) return prose.today;
  return key === new Date(Date.now() - 86_400_000).toDateString() ? prose.yesterday : key;
}

export function OverleafHistoryPanel(props: {
  /** The project this drawer was opened for; every request is scoped to it. */
  projectRoot: string;
  /** Close the whole drawer — jumping to a line from a diff gets out of the way. */
  onClose: () => void;
  /** Put the caret on a line from a rendered diff, the way the Changes/Versions tabs do. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Called after any successful restore: the caller's cue to sync and reload. */
  onRestored?: () => void;
}) {
  const { t } = useLingui();
  // Overleaf's editor leaves no origin (or "web"); anything else — an upload,
  // Dropbox, the git bridge, a restore — is named, so a change that did not
  // come from someone typing in the browser doesn't read as if it did.
  const originNames: Record<string, string> = {
    upload: t`file upload`,
    dropbox: "Dropbox",
    "git-bridge": t`git bridge`,
    "file-restore": t`file restore`,
    "project-restore": t`project restore`,
  };
  const fileOpLabel: Record<OverleafFileOperation, string> = {
    added: t`added`,
    removed: t`removed`,
    renamed: t`renamed`,
    edited: t`edited`,
  };
  const history = useOverleafHistory(props.projectRoot);
  const [expanded, setExpanded] = useState<number | null>(null);
  const files = useLatestLoad<OverleafFileEntry[]>();
  const diff = useLatestLoad<OverleafDiffChunk[] | { binary: true }>();
  /** The version whose "Name this version" field is open, and what has been typed into it. */
  const [labelDraft, setLabelDraft] = useState<{ version: number; text: string } | null>(null);

  const grouped = useMemo(() => {
    const groups = new Map<string, OverleafUpdate[]>();
    for (const update of history.updates) {
      const key = new Date(update.endTs).toDateString();
      groups.set(key, [...(groups.get(key) ?? []), update]);
    }
    return [...groups.entries()];
  }, [history.updates]);

  const toggleEntry = (update: OverleafUpdate) => {
    diff.clear();
    setLabelDraft(null);
    if (expanded === update.toVersion) {
      setExpanded(null);
      files.clear();
      return;
    }
    setExpanded(update.toVersion);
    files.load(String(update.toVersion), () => invoke<{ diff: OverleafFileEntry[] }>("overleaf_history_files", {
      projectRoot: props.projectRoot,
      from: update.fromVersion,
      to: update.toVersion,
    }).then((result) => result.diff.filter((entry) => entry.operation !== undefined)));
  };

  const openDiff = (update: OverleafUpdate, path: string) => {
    // The row is a toggle: clicking the open file closes it again, which is
    // what a row that stays highlighted while open leads you to expect.
    if (diff.key === path) return diff.clear();
    diff.load(path, () => invoke<{ diff: OverleafDiffChunk[] | { binary: true } }>("overleaf_history_diff", {
      projectRoot: props.projectRoot,
      path,
      from: update.fromVersion,
      to: update.toVersion,
    }).then((result) => result.diff));
  };

  /** Run a restore/label action and say what happened; on failure the hook surfaces the reason above the list. */
  const run = (onOk: string, action: () => Promise<void>) => action()
    .then(() => notifySuccess(OVERLEAF_HISTORY_SOURCE, onOk))
    .catch(() => undefined);
  const confirmThenRun = async (warning: string, onOk: string, action: () => Promise<void>) => {
    if (await confirmAction(warning)) void run(onOk, action);
  };
  const restored = () => props.onRestored?.();

  const renderDiff = (update: OverleafUpdate, path: string) => {
    if (diff.loading) return <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>;
    if (diff.error) return <p className="history-diff-error" role="alert">{diff.error}</p>;
    if (!diff.value) return null;
    const binary = !Array.isArray(diff.value);
    return (
      <HistoryDiff
        key={`${update.toVersion}:${path}`}
        change={binary ? { path } : textFromDiffChunks(path, diff.value as OverleafDiffChunk[])}
        binary={binary}
        onOpenLine={props.onOpenFile && ((openPath, line) => {
          props.onOpenFile?.(openPath, line);
          props.onClose();
        })}
      />
    );
  };

  const renderFile = (update: OverleafUpdate, file: OverleafFileEntry) => {
    const deleted = file.operation === "removed" && file.deletedAtV != null;
    return (
      <div className="overleaf-history-file-row" key={file.pathname}>
        <button
          type="button"
          className={`versions-file overleaf-history-file ${diff.key === file.pathname || diff.key === file.newPathname ? "active" : ""}`}
          title={`${fileOpLabel[file.operation ?? "edited"]}: ${file.pathname}`}
          onClick={() => openDiff(update, file.newPathname ?? file.pathname)}
        >
          <FileKindIcon kind={file.operation ?? "edited"} />
          <span>{file.operation === "renamed" && file.newPathname ? `${file.pathname} → ${file.newPathname}` : file.pathname}</span>
        </button>
        <button
          type="button"
          className="versions-restore-file"
          title={deleted ? t`Bring back ${file.pathname}` : t`Restore ${file.pathname} to this version`}
          disabled={history.busy}
          onClick={() => void run(t`Restored ${file.pathname}.`, () => (deleted
            ? history.restoreDeletedFile(file.deletedAtV!, file.pathname)
            : history.revertFile(update.toVersion, file.pathname)).then(restored))}
        >
          <RotateCcw size={10} /> {deleted ? t`Restore` : t`Restore this file`}
        </button>
      </div>
    );
  };

  const renderBody = (update: OverleafUpdate) => (
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
                  onClick={() => void confirmThenRun(
                    t`Remove the “${label.comment}” label from this Overleaf version?`,
                    t`Label removed.`,
                    () => history.deleteLabel(label.id),
                  )}
                />
              </span>
            ))}
          </div>
        )}
        {labelDraft?.version === update.toVersion ? (
          <form
            className="overleaf-history-label-form"
            onSubmit={(event) => {
              event.preventDefault();
              const comment = labelDraft.text.trim();
              if (comment) void run(t`Version named.`, () => history.addLabel(update.toVersion, comment)).then(() => setLabelDraft(null));
            }}
          >
            <Input
              controlSize="compact"
              autoFocus
              value={labelDraft.text}
              placeholder={t`Name this version…`}
              aria-label={t`Version label`}
              onChange={(event) => setLabelDraft({ version: update.toVersion, text: event.target.value })}
            />
            <button type="submit" disabled={!labelDraft.text.trim() || history.busy}>{t`Save`}</button>
            <button type="button" onClick={() => setLabelDraft(null)}>{t`Cancel`}</button>
          </form>
        ) : (
          <button type="button" className="overleaf-history-name-version" onClick={() => setLabelDraft({ version: update.toVersion, text: "" })}>
            <Tag size={11} aria-hidden /> {t`Name this version`}
          </button>
        )}
      </div>

      {files.loading && <p className="git-empty"><InfinityLoader size={12} /> {t`Loading files…`}</p>}
      {files.error && <InlineMessage level="error" className="versions-inline">{files.error}</InlineMessage>}
      {files.value?.length === 0 && <p className="versions-note">{t`No file changes recorded for this update`}</p>}
      {!!files.value?.length && <div className="versions-files">{files.value.map((file) => renderFile(update, file))}</div>}

      {diff.key && renderDiff(update, diff.key)}

      <button
        type="button"
        className="versions-restore-project"
        disabled={history.busy}
        onClick={() => void confirmThenRun(
          t`Restore the whole project to this version? Files added since will be deleted, and everything else will be rewound to match. The only way back from here is another restore.`,
          t`Project restored.`,
          () => history.revertProject(update.toVersion).then(restored),
        )}
      >
        <RotateCcw size={12} /> {t`Restore whole project to this version`}
      </button>
    </div>
  );

  const renderEntry = (update: OverleafUpdate) => {
    const expandedHere = expanded === update.toVersion;
    const primaryAuthor = update.authors[0] ?? t`Unknown`;
    const color = peerColorForName(primaryAuthor);
    const origin = update.origin && update.origin !== "web" && update.origin !== "editor"
      ? originNames[update.origin] ?? update.origin
      : null;
    return (
      <div className={`versions-entry ${expandedHere ? "expanded" : ""}`} key={update.toVersion}>
        <button type="button" className="versions-entry-head" aria-expanded={expandedHere} onClick={() => toggleEntry(update)}>
          <span className="versions-entry-top">
            <span className="versions-author" style={{ background: color.colorLight, color: color.color }}>
              {primaryAuthor}{update.authors.length > 1 ? ` +${update.authors.length - 1}` : ""}
            </span>
            <span className="versions-time" title={new Date(update.endTs).toLocaleString()}>{clockTime(update.endTs)}</span>
            <span className="versions-count">
              {update.paths.length === 1 ? t`${update.paths.length} file` : t`${update.paths.length} files`}
            </span>
          </span>
          {(origin || update.labels.length > 0) && (
            <span className="overleaf-history-entry-meta">
              {origin && <span className="overleaf-history-origin">{origin}</span>}
              {update.labels.map((label) => (
                <span className="overleaf-history-label" key={label.id}><Tag size={9} aria-hidden /> {label.comment}</span>
              ))}
            </span>
          )}
          {update.paths.length > 0 && <p className="overleaf-history-paths">{update.paths.join(", ")}</p>}
        </button>
        {expandedHere && renderBody(update)}
      </div>
    );
  };

  return (
    <div className="overleaf-history-panel">
      <p className="drawer-copy">
        {t`Overleaf's own record of this project, including everything collaborators changed in the browser while Lattice was closed. Restoring here changes Overleaf's copy — sync afterward to bring the result into this app`}
      </p>

      {history.error && <InlineMessage level="error" className="versions-inline">{history.error}</InlineMessage>}

      {history.loading && !history.updates.length && (
        <p className="versions-loading"><InfinityLoader size={13} /> {t`Loading Overleaf's history…`}</p>
      )}
      {!history.loading && !history.updates.length && !history.error && (
        <p className="versions-note">{t`No history yet`}</p>
      )}

      <div className="overleaf-history-list">
        {grouped.map(([key, dayUpdates]) => (
          <div className="overleaf-history-day" key={key}>
            <h3 className="overleaf-history-day-label">{dayLabel(key, { today: t`Today`, yesterday: t`Yesterday` })}</h3>
            {dayUpdates.map(renderEntry)}
          </div>
        ))}
      </div>

      {history.hasMore && (
        <button type="button" className="overleaf-history-load-more" disabled={history.loadingMore} onClick={() => void history.loadMore()}>
          {history.loadingMore && <InfinityLoader size={12} />} {t`Load more`}
        </button>
      )}
    </div>
  );
}
