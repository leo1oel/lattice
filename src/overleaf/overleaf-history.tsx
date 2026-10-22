/**
 * Overleaf's own project history on the history timeline, browsed and
 * restored from inside Lattice.
 *
 * Overleaf keeps this history on its servers. It covers every edit a
 * collaborator made in the browser while Lattice was closed, and none of that
 * is in local git, so it is a source of its own beside the versions and
 * Lattice's activity. An entry reads like a version: a person, a clock time,
 * the files, and a filled glyph when Overleaf has a name for it. Restoring
 * rewrites Overleaf's copy, not the local files, so the caller is expected to
 * sync afterward (see `onRestored`).
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitCompareArrows, Leaf, RotateCcw, Tag } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { FileKindIcon, HistoryDiff } from "../history/file-diff-view";
import { useLatestLoad } from "../history/use-latest-load";
import { HistoryPerson, HistoryRow } from "../history/history-row";
import { clockTime, fullTime } from "../history/history-time";
import { Input } from "../components/ui/input";
import { confirmAction } from "../app-utils";
import { DestructiveButton } from "../components/ui/destructive-button";
import { EmptyState } from "../components/ui/empty-state";
import { InlineMessage } from "../components/ui/inline-message";
import { ResearchArt } from "../components/ui/research-art";
import { DATED_DRAFTS } from "../components/ui/research-art-dated-drafts";
import { notifySuccess } from "../telemetry/app-notify";
import { InfinityLoader } from "../components/ui/activity-icons";
import { formatCount } from "../i18n";
import { textFromDiffChunks, type useOverleafHistory } from "./use-overleaf-history";
import type { OverleafDiffChunk, OverleafFileEntry, OverleafFileOperation, OverleafUpdate } from "./use-overleaf-history";
import "./overleaf-history.css";

export type OverleafHistory = ReturnType<typeof useOverleafHistory>;

type OverleafRowProps = {
  update: OverleafUpdate;
  history: OverleafHistory;
  /** The project this drawer was opened for; every request is scoped to it. */
  projectRoot: string;
  expanded: boolean;
  /** Opened to compare with Overleaf's newest version rather than to read this entry's own changes. */
  compare: boolean;
  onToggle: () => void;
  onCompare: () => void;
  /** Close the whole drawer — jumping to a line from a diff gets out of the way. */
  onClose: () => void;
  /** Put the caret on a line from a rendered diff, the way Activity does. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Called after any successful restore: the caller's cue to sync and reload. */
  onRestored?: () => void;
};

/** One entry of Overleaf's history on the timeline. */
export function OverleafHistoryRow(props: OverleafRowProps) {
  const { i18n, t } = useLingui();
  // Overleaf's editor leaves no origin (or "web"); anything else — an upload,
  // Dropbox, the git bridge, a restore — is named, so a change that did not
  // come from someone typing in the browser doesn't read as if it did.
  const originNames: Record<string, string> = {
    upload: t`file upload`,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- product name
    dropbox: "Dropbox",
    "git-bridge": t`git bridge`,
    "file-restore": t`file restore`,
    "project-restore": t`project restore`,
  };
  const { update } = props;
  const origin = update.origin && update.origin !== "web" && update.origin !== "editor"
    ? originNames[update.origin] ?? update.origin
    : null;
  /** Rewind Overleaf's whole project to this entry, once the reader confirms what that deletes. */
  const restoreProject = async () => {
    const warning = t`Restore the whole project to this version on Overleaf? Files added since will be deleted, and everything else will be rewound to match. The only way back from here is another restore.`;
    if (!await confirmAction(warning)) return;
    await props.history.revertProject(update.toVersion)
      .then(() => {
        notifySuccess(t`Overleaf history`, t`Project restored.`);
        props.onRestored?.();
      })
      .catch(() => undefined);
  };
  const label = update.labels[0]?.comment;
  const others = update.authors.length - 1;
  return (
    <HistoryRow
      glyph={label ? <Tag size={13} strokeWidth={1.75} /> : <Leaf size={13} strokeWidth={1.75} />}
      weight={label ? "named" : "plain"}
      tone="overleaf"
      title={label ?? (update.paths.join(", ") || t`Edits`)}
      meta={(
        <>
          <HistoryPerson name={update.authors[0] ?? t`Unknown`} suffix={others > 0 ? ` +${formatCount(others)}` : undefined} />
          {origin && <span className="history-row-tag">{origin}</span>}
          {label && update.paths.length > 0 && <span className="history-row-detail">{update.paths.join(", ")}</span>}
        </>
      )}
      time={clockTime(update.endTs, i18n.locale)}
      timeTitle={fullTime(update.endTs, i18n.locale)}
      expanded={props.expanded}
      onToggle={props.onToggle}
      tools={(
        <>
          <button type="button" className="history-tool" title={t`Compare with now`} aria-label={t`Compare with now`} aria-pressed={props.expanded && props.compare} onClick={props.onCompare}>
            <GitCompareArrows size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="history-tool"
            title={t`Restore whole project to this version`}
            aria-label={t`Restore whole project to this version`}
            disabled={props.history.busy}
            onClick={() => void restoreProject()}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </>
      )}
    >
      <OverleafHistoryBody key={props.compare ? "now" : "version"} {...props} onRestoreProject={restoreProject} />
    </HistoryRow>
  );
}

/** An opened entry: its names, the files it changed with their diffs, and the restores. */
function OverleafHistoryBody(props: OverleafRowProps & { onRestoreProject: () => Promise<void> }) {
  const { t } = useLingui();
  const fileOpLabel: Record<OverleafFileOperation, string> = {
    added: t`added`,
    removed: t`removed`,
    renamed: t`renamed`,
    edited: t`edited`,
  };
  const { update, history } = props;
  const files = useLatestLoad<OverleafFileEntry[]>();
  const diff = useLatestLoad<OverleafDiffChunk[] | { binary: true }>();
  /** What has been typed into the open "Name this version" field, or null when it is closed. */
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  // Opening the entry reads which files it changed. The read starts through a
  // ref so the effect body holds no traceable synchronous setState call.
  // Its own changes run from the version before it; compared with now, from it to Overleaf's newest.
  const newest = history.updates[0]?.toVersion ?? update.toVersion;
  const range = props.compare ? { from: update.toVersion, to: newest } : { from: update.fromVersion, to: update.toVersion };
  const unchanged = range.from >= range.to;
  const loadFiles = () => {
    if (unchanged) return;
    files.load(`${range.from}:${range.to}`, () => invoke<{ diff: OverleafFileEntry[] }>("overleaf_history_files", {
      projectRoot: props.projectRoot,
      ...range,
    }).then((result) => result.diff.filter((entry) => entry.operation !== undefined)));
  };
  const loadFilesRef = useRef(loadFiles);
  useEffect(() => {
    loadFilesRef.current = loadFiles;
  });
  useEffect(() => {
    loadFilesRef.current();
  }, [range.from, range.to]);

  const openDiff = (path: string) => {
    // A file is a toggle: clicking the open one closes it again.
    if (diff.key === path) return diff.clear();
    diff.load(path, () => invoke<{ diff: OverleafDiffChunk[] | { binary: true } }>("overleaf_history_diff", {
      projectRoot: props.projectRoot,
      path,
      ...range,
    }).then((result) => result.diff));
  };

  /** Run a restore/label action and say what happened; on failure the hook surfaces the reason above the list. */
  const run = (onOk: string, action: () => Promise<void>) => action()
    .then(() => notifySuccess(t`Overleaf history`, onOk))
    .catch(() => undefined);
  const confirmThenRun = async (warning: string, onOk: string, action: () => Promise<void>) => {
    if (await confirmAction(warning)) void run(onOk, action);
  };
  const restored = () => props.onRestored?.();

  const renderDiff = (path: string) => {
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

  const renderFile = (file: OverleafFileEntry) => {
    const deleted = file.operation === "removed" && file.deletedAtV != null;
    const operation = fileOpLabel[file.operation ?? "edited"] ?? fileOpLabel.edited;
    const name = file.operation === "renamed" && file.newPathname ? `${file.pathname} → ${file.newPathname}` : file.pathname;
    const open = diff.key === file.pathname || diff.key === file.newPathname;
    return (
      <div className="overleaf-history-file-row" key={file.pathname}>
        <button
          type="button"
          className={`version-file overleaf-history-file${open ? " active" : ""}`}
          aria-pressed={open}
          title={name}
          aria-description={operation}
          onClick={() => openDiff(file.newPathname ?? file.pathname)}
        >
          <FileKindIcon kind={file.operation ?? "edited"} />
          <span>{name}</span>
        </button>
        <button
          type="button"
          className="version-file-restore"
          disabled={history.busy}
          onClick={() => void run(t`Restored ${file.pathname}.`, () => (deleted
            ? history.restoreDeletedFile(file.deletedAtV!, file.pathname)
            : history.revertFile(update.toVersion, file.pathname)).then(restored))}
        >
          <RotateCcw size={11} aria-hidden="true" /> {deleted ? t`Restore` : t`Restore this file`}
        </button>
      </div>
    );
  };

  return (
    <div className="version-body">
      {props.compare && (
        <p className="version-mode-note">
          {unchanged ? t`Nothing has changed on Overleaf since this version` : t`Compared with now`}
          {" · "}
          <button type="button" className="version-mode-switch" onClick={props.onCompare}>{t`Show this version's changes`}</button>
        </p>
      )}
      <div className="overleaf-history-labels-row">
        {update.labels.map((label) => (
          <span className="overleaf-history-label-chip" key={label.id}>
            <Tag size={10} aria-hidden /> <span>{label.comment}</span>
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
        {labelDraft !== null ? (
          <form
            className="overleaf-history-label-form"
            onSubmit={(event) => {
              event.preventDefault();
              const comment = labelDraft.trim();
              if (comment) void run(t`Version named.`, () => history.addLabel(update.toVersion, comment)).then(() => setLabelDraft(null));
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
            <button type="button" onClick={() => setLabelDraft(null)}>{t`Cancel`}</button>
          </form>
        ) : (
          <button type="button" className="overleaf-history-name-version" onClick={() => setLabelDraft("")}>
            <Tag size={11} aria-hidden /> {t`Name this version`}
          </button>
        )}
      </div>

      {files.loading && <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading files…`}</p>}
      {files.error && <InlineMessage level="error">{files.error}</InlineMessage>}
      {files.value?.length === 0 && <p className="version-note overleaf-history-no-files">{t`No file changes recorded for this update`}</p>}
      {!!files.value?.length && (
        <div className="overleaf-history-files" role="group" aria-label={t`Files in this version`}>
          {files.value.map(renderFile)}
        </div>
      )}

      {diff.key && renderDiff(diff.key)}

      <div className="version-actions">
        {!props.compare && (
          <button type="button" className="version-action" onClick={props.onCompare}>
            <GitCompareArrows size={12} aria-hidden="true" /> {t`Compare with now`}
          </button>
        )}
        <button type="button" className="version-action" disabled={history.busy} onClick={() => void props.onRestoreProject()}>
          <RotateCcw size={12} /> {t`Restore whole project to this version`}
        </button>
      </div>
    </div>
  );
}

/** What the timeline says about Overleaf's history when it has no entries to show, or could not read them. */
export function OverleafHistoryState(props: { history: OverleafHistory; alone: boolean }) {
  const { t } = useLingui();
  const { history } = props;
  return (
    <>
      {history.error && <InlineMessage level="error" className="versions-inline">{history.error}</InlineMessage>}
      {props.alone && history.loading && !history.updates.length && (
        <p className="versions-loading"><InfinityLoader size={13} /> {t`Loading Overleaf's history…`}</p>
      )}
      {props.alone && !history.loading && !history.updates.length && !history.error && (
        <EmptyState
          className="history-empty"
          fill
          icon={<ResearchArt drawing={DATED_DRAFTS} />}
          title={t`No Overleaf history yet`}
        />
      )}
    </>
  );
}
