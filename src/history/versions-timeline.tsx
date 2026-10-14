/**
 * The project's git versions on the history timeline. A version someone saved
 * or named stands out; the ones Lattice makes on its own (after a sync, after
 * a build) fold into one quiet line, because a linked project makes one every
 * couple of minutes and they would bury the deliberate ones. An opened version
 * reads its changes as prose, sentence by sentence with the edits marked,
 * before anything is restored; the source diff is one switch away.
 */
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, GitCommitHorizontal, GitCompareArrows, RotateCcw, Save, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import type { GitFileDiff, GitLogEntry, GitLogFileKind } from "../app-types";
import { InlineMessage } from "../components/ui/inline-message";
import { EmptyState } from "../components/ui/empty-state";
import { ResearchArt } from "../components/ui/research-art";
import { DATED_DRAFTS } from "../components/ui/research-art-dated-drafts";
import { InlineEdits } from "../components/ui/inline-edits";
import { SegmentedControl } from "../components/ui/segmented-control";
import { InfinityLoader, ReloadButton, ReloadIconButton } from "../components/ui/activity-icons";
import { Input } from "../components/ui/input";
import { formatCount } from "../i18n";
import { FileKindIcon, HistoryDiff } from "./file-diff-view";
import { useLatestLoad } from "./use-latest-load";
import type { GitVersions } from "./use-git-versions";
import { isAutomaticVersion, isBookkeepingVersion, versionMessageLabel } from "./version-messages";
import { PROSE_FILE, prosePassages } from "./version-prose";
import { HistoryPerson, HistoryRow } from "./history-row";
import { clockTime, fullTime } from "./history-time";

/** One version on the timeline; opening it reads what it changed, or how it differs from now. */
export function VersionRow(props: {
  entry: GitLogEntry;
  versions: GitVersions;
  /** The project the files are read from when comparing with now. */
  projectRoot?: string;
  expanded: boolean;
  /** Opened to compare with the files as they are now rather than to read this version's own changes. */
  compare: boolean;
  onToggle: () => void;
  onCompare: () => void;
  source?: string;
}) {
  const { i18n, t } = useLingui();
  const { entry, versions } = props;
  const at = new Date(entry.timestamp).getTime();
  const count = entry.files.length;
  return (
    <HistoryRow
      glyph={<GitCommitHorizontal size={14} strokeWidth={1.75} />}
      weight={isAutomaticVersion(entry.message) ? "quiet" : isBookkeepingVersion(entry.message) ? "plain" : "named"}
      tone="version"
      title={versionMessageLabel(entry.message)}
      meta={(
        <>
          <HistoryPerson name={entry.authorName || t`Unknown`} />
          <span className="history-row-count">{count === 1 ? t`1 file` : t`${formatCount(count)} files`}</span>
        </>
      )}
      time={clockTime(at, i18n.locale)}
      timeTitle={fullTime(at, i18n.locale)}
      source={props.source}
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
            title={t`Restore project to this version`}
            aria-label={t`Restore project to this version`}
            disabled={versions.busy}
            onClick={() => void versions.restoreProject(entry.hash)}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </>
      )}
    >
      <VersionBody key={props.compare ? "now" : "version"} entry={entry} versions={versions} projectRoot={props.projectRoot} compare={props.compare} onCompare={props.onCompare} />
    </HistoryRow>
  );
}

/** A run of automatic versions, folded to one line until it is opened. */
export function AutomaticVersionsRow(props: { entries: GitLogEntry[]; open: boolean; onToggle: () => void; source?: string }) {
  const { i18n, t } = useLingui();
  const newest = new Date(props.entries[0]!.timestamp).getTime();
  const oldest = new Date(props.entries.at(-1)!.timestamp).getTime();
  const count = formatCount(props.entries.length);
  const since = clockTime(oldest, i18n.locale);
  const Chevron = props.open ? ChevronDown : ChevronRight;
  return (
    <HistoryRow
      className="history-fold"
      glyph={<Chevron size={12} />}
      weight="quiet"
      tone="version"
      title={t`${count} automatic versions`}
      meta={<span className="history-row-detail">{t`Saved by Lattice after syncs and builds since ${since}`}</span>}
      time={clockTime(newest, i18n.locale)}
      timeTitle={`${fullTime(oldest, i18n.locale)} – ${fullTime(newest, i18n.locale)}`}
      source={props.source}
      expanded={props.open}
      onToggle={props.onToggle}
    />
  );
}

/** Past this many files a version lists the first ones and offers the rest on request. */
const FILE_CHIPS = 12;

/** An opened version: its files, the open file's changes read as prose (or its source diff), and the restores. */
function VersionBody(props: { entry: GitLogEntry; versions: GitVersions; projectRoot?: string; compare: boolean; onCompare: () => void }) {
  const { t } = useLingui();
  const { entry, versions } = props;
  // Git's own file-status words, read in each chip's tooltip.
  const fileKindLabel: Record<GitLogFileKind, string> = {
    added: t`added`,
    deleted: t`deleted`,
    renamed: t`renamed`,
    modified: t`modified`,
  };
  const [activePath, setActivePath] = useState<string | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  const fileDiff = useLatestLoad<GitFileDiff>();

  const openFile = (path: string) => {
    // A chip is a toggle: clicking the open file closes it again.
    if (activePath === path) {
      setActivePath(null);
      fileDiff.clear();
      return;
    }
    setActivePath(path);
    const atVersion = () => invoke<GitFileDiff>("git_show_diff", { rev: entry.hash, path });
    fileDiff.load(`${entry.hash}:${path}`, props.compare
      // Compared with now: the file as this version left it, against the file on disk (null once deleted).
      ? () => Promise.all([
        atVersion(),
        invoke<string>("read_project_file", { path, projectRoot: props.projectRoot }).catch(() => null),
      ]).then(([version, now]) => ({ before: version.after, after: now, binary: version.binary }))
      : atVersion);
  };

  const files = allFiles ? entry.files : entry.files.slice(0, FILE_CHIPS);
  const hidden = formatCount(entry.files.length - files.length);
  return (
    <div className="version-body">
      {props.compare && (
        <p className="version-mode-note">
          {t`These files as this version left them, compared with now`}
          {" · "}
          <button type="button" className="version-mode-switch" onClick={props.onCompare}>{t`Show this version's changes`}</button>
        </p>
      )}
      <div className="version-files" role="group" aria-label={t`Files in this version`}>
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={`version-file${activePath === file.path ? " active" : ""}`}
            aria-pressed={activePath === file.path}
            title={`${fileKindLabel[file.kind]}: ${file.path}`}
            onClick={() => openFile(file.path)}
          >
            <FileKindIcon kind={file.kind} />
            <span>{file.path}</span>
          </button>
        ))}
        {files.length < entry.files.length && (
          <button type="button" className="version-more-files" onClick={() => setAllFiles(true)}>
            {t`${hidden} more files`}
          </button>
        )}
      </div>
      {activePath && (
        <VersionFileChanges
          key={activePath}
          path={activePath}
          diff={fileDiff.value}
          error={fileDiff.error}
        />
      )}
      <div className="version-actions">
        {!props.compare && (
          <button type="button" className="version-action" onClick={props.onCompare}>
            <GitCompareArrows size={12} aria-hidden="true" /> {t`Compare with now`}
          </button>
        )}
        {activePath && (
          <button
            type="button"
            className="version-action"
            disabled={versions.busy}
            title={t`Restore ${activePath} to this version`}
            onClick={() => void versions.restoreFile(entry.hash, activePath)}
          >
            <RotateCcw size={12} /> {t`Restore this file`}
          </button>
        )}
        <button type="button" className="version-action" disabled={versions.busy} onClick={() => void versions.restoreProject(entry.hash)}>
          <RotateCcw size={12} /> {t`Restore project to this version`}
        </button>
        <span className="version-note">{t`The current state is saved as a version first`}</span>
      </div>
    </div>
  );
}

/**
 * One file's changes in an opened version. Prose files read as their changed
 * passages in the reading font, each edit struck and marked, with ↑ ↓ to step
 * between them; Source shows the line diff. A binary file, or a change too
 * large to read as passages, shows the source view alone.
 */
function VersionFileChanges(props: { path: string; diff: GitFileDiff | null; error: string }) {
  const { t } = useLingui();
  const [mode, setMode] = useState<"text" | "source">("text");
  const [current, setCurrent] = useState(0);
  const passageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const { diff, path } = props;
  if (props.error) return <InlineMessage level="error">{props.error}</InlineMessage>;
  if (!diff) return <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>;

  const passages = !diff.binary && PROSE_FILE.test(path) ? prosePassages(diff.before ?? "", diff.after ?? "") : null;
  if (!passages || mode === "source") {
    return (
      <div className="version-reader">
        {passages && <ReaderModeSwitch mode={mode} onMode={setMode} />}
        <HistoryDiff change={{ path, before: diff.before, after: diff.after }} binary={diff.binary} />
      </div>
    );
  }

  const step = (by: number) => {
    const next = Math.min(passages.length - 1, Math.max(0, current + by));
    setCurrent(next);
    passageRefs.current[next]?.scrollIntoView({ block: "nearest" });
    passageRefs.current[next]?.focus({ preventScroll: true });
  };
  const count = formatCount(passages.length);
  return (
    <div className="version-reader">
      <ReaderModeSwitch mode={mode} onMode={setMode} />
      <div className="version-prose" aria-label={t`Changes in ${path}`}>
        {passages.length > 0 && <div className="version-prose-head">
          <span>{passages.length === 1 ? t`1 change` : t`${count} changes`}</span>
          {passages.length > 1 && (
            <span className="version-prose-steps">
              <button type="button" className="version-step" aria-label={t`Previous change`} disabled={current === 0} onClick={() => step(-1)}>
                <ArrowUp size={12} aria-hidden="true" />
              </button>
              <button type="button" className="version-step" aria-label={t`Next change`} disabled={current === passages.length - 1} onClick={() => step(1)}>
                <ArrowDown size={12} aria-hidden="true" />
              </button>
            </span>
          )}
        </div>}
        {!passages.length && <p className="version-prose-empty">{t`No textual changes`}</p>}
        {passages.map((passage, index) => (
          <div
            key={`${passage.line}:${index}`}
            ref={(node) => { passageRefs.current[index] = node; }}
            className="version-passage"
            data-current={passages.length > 1 && index === current ? "true" : undefined}
            tabIndex={-1}
          >
            <span className="version-passage-line" title={t`Line ${passage.line} of this version`}>{passage.line}</span>
            <div className="version-passage-text">
              {passage.clippedStart && <span className="version-passage-gap" aria-hidden="true">…</span>}
              <InlineEdits text={passage.text} edits={passage.edits} />
              {passage.clippedEnd && <span className="version-passage-gap" aria-hidden="true">…</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReaderModeSwitch(props: { mode: "text" | "source"; onMode: (mode: "text" | "source") => void }) {
  const { t } = useLingui();
  return (
    <SegmentedControl
      className="version-reader-mode"
      value={props.mode}
      onChange={props.onMode}
      ariaLabel={t`Show changes as`}
      items={[{ value: "text", label: t`Text` }, { value: "source", label: t`Source` }]}
    />
  );
}

/** The views (`children`), then Save version and a refresh; saving opens a field for the version's name under them. */
export function VersionsToolbar(props: { versions: GitVersions; children?: ReactNode }) {
  const { t } = useLingui();
  const { versions } = props;
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const close = () => {
    setOpen(false);
    setLabel("");
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await versions.saveVersion(label.trim())) close();
  };
  return (
    <>
      <div className="versions-toolbar">
        {props.children}
        {versions.phase === "ready" && (
          <button
            type="button"
            className="versions-save"
            disabled={versions.busy || open}
            title={t`Save version`}
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <Save size={12} aria-hidden="true" /> <span className="versions-save-label">{t`Save version`}</span>
          </button>
        )}
        <ReloadIconButton
          className="versions-icon-button"
          label={t`Refresh history`}
          tooltip={t`Refresh history`}
          busy={versions.refreshing}
          disabled={versions.refreshing || versions.busy}
          onClick={() => void versions.reload()}
          iconSize={13}
        />
      </div>
      {open && (
        <form className="versions-save-form" onSubmit={(event) => void submit(event)}>
          <Input
            className="versions-save-input"
            controlSize="compact"
            autoFocus
            placeholder={t`Name this version, e.g. Sent to co-authors`}
            aria-label={t`Version label`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape closes the field, not the drawer around it.
              event.stopPropagation();
              close();
            }}
          />
          <button type="submit" className="versions-save" disabled={versions.busy}>
            <Save size={12} /> {t`Save`}
          </button>
          <button type="button" className="versions-icon-button" title={t`Cancel`} aria-label={t`Cancel`} onClick={close}>
            <X size={13} />
          </button>
        </form>
      )}
    </>
  );
}

/**
 * What the timeline says in place of versions: loading, no Git on this Mac,
 * Git unreachable, version tracking off, or no versions yet. Null once there
 * are versions to list.
 */
export function VersionsState(props: { versions: GitVersions }) {
  const { t } = useLingui();
  const { versions } = props;
  if (versions.phase === "loading") {
    return <p className="versions-loading"><InfinityLoader size={13} /> {t`Loading versions…`}</p>;
  }
  if (versions.phase === "unavailable") {
    return (
      <EmptyState
        className="history-empty"
        fill
        icon={<ResearchArt drawing={DATED_DRAFTS} />}
        title={t`No version history`}
        description={t`Version history needs Git, which isn’t available on this Mac`}
      />
    );
  }
  if (versions.phase === "error") {
    return (
      <div className="versions-problem">
        <InlineMessage level="error">{t`Version history is unavailable: ${versions.error}`}</InlineMessage>
        <ReloadButton className="versions-save" busy={versions.refreshing} disabled={versions.refreshing} onClick={() => void versions.reload()}>
          {t`Try again`}
        </ReloadButton>
      </div>
    );
  }
  if (versions.phase === "no-repo") {
    return (
      <>
        {versions.error && <InlineMessage level="error" className="versions-inline">{versions.error}</InlineMessage>}
        <EmptyState
          className="history-empty"
          fill
          icon={<ResearchArt drawing={DATED_DRAFTS} />}
          title={t`Version tracking is off`}
          description={t`Turn it on and Lattice keeps dated versions of this project with Git, so any earlier draft is a click away`}
          actions={(
            <button type="button" className="versions-save" disabled={versions.busy} onClick={() => void versions.enableTracking()}>
              <GitBranch size={13} /> {t`Enable version tracking`}
            </button>
          )}
        />
      </>
    );
  }
  if (!versions.entries.length) {
    return (
      <>
        {versions.error && <InlineMessage level="error" className="versions-inline">{versions.error}</InlineMessage>}
        <EmptyState
          className="history-empty"
          fill
          icon={<ResearchArt drawing={DATED_DRAFTS} />}
          title={t`No versions yet`}
          description={t`Save a version to mark a draft you can come back to. A project linked to Overleaf also saves one after each sync and successful build`}
        />
      </>
    );
  }
  return versions.error ? <InlineMessage level="error" className="versions-inline">{versions.error}</InlineMessage> : null;
}

/**
 * The versions' state as one quiet line above the whole stream, where a full
 * empty state would crowd out the activity and Overleaf rows: tracking off
 * (with the switch) or Git unreachable. Nothing while loading or when fine.
 */
export function VersionsNotice(props: { versions: GitVersions }) {
  const { t } = useLingui();
  const { versions } = props;
  if (versions.phase === "error") {
    return <InlineMessage level="error" className="versions-inline">{t`Version history is unavailable: ${versions.error}`}</InlineMessage>;
  }
  if (versions.phase !== "no-repo") {
    return versions.phase === "ready" && versions.error ? <InlineMessage level="error" className="versions-inline">{versions.error}</InlineMessage> : null;
  }
  return (
    <div className="versions-notice">
      <span>{t`Version tracking is off for this project`}</span>
      <button type="button" className="version-mode-switch" disabled={versions.busy} onClick={() => void versions.enableTracking()}>
        {t`Enable version tracking`}
      </button>
    </div>
  );
}
