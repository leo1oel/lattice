import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { historyFocus, subscribeHistoryFocus } from "./history-focus";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDownUp, BookMarked, History, PenLine, RotateCcw, Sparkles } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { ResearchArt } from "../components/ui/research-art";
import { DATED_DRAFTS } from "../components/ui/research-art-dated-drafts";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { SlidingTabs } from "../components/ui/motion";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { formatCount } from "../i18n";
import type { GitLogEntry } from "../app-types";
import { OverleafHistoryRow, OverleafHistoryState, type OverleafHistory } from "../overleaf/overleaf-history";
import { useOverleafHistory, type OverleafUpdate } from "../overleaf/use-overleaf-history";
import { AutomaticVersionsRow, VersionRow, VersionsState, VersionsToolbar } from "./versions-timeline";
import { isAutomaticVersion } from "./version-messages";
import { useGitVersions, type GitVersions } from "./use-git-versions";
import { HistoryDay, HistoryRow, HistoryStat } from "./history-row";
import { clockTime, dayName, fullTime, groupByDay } from "./history-time";
import { ChangeKindLabel, HistoryDiff } from "./file-diff-view";
import { useLatestLoad } from "./use-latest-load";
import {
  pierreCodeViewOptions,
  pierreFileDiff,
  pierreLanguageForPath,
  topVisibleIndex,
  usePierreResources,
  type DiffFileChange,
} from "./pierre-diff";
import "./history-timeline.css";

export type HistoryItem = {
  id: string;
  label: string;
  timestamp: string;
  files: string[];
  actor?: "user" | "agent" | "citation" | "system" | string;
  kind?: string;
  source?: string;
  threadId?: string | null;
  threadTitle?: string | null;
  checkpointRef?: string | null;
  turnCount?: number | null;
  undoOf?: string | null;
  fileSummaries?: Array<{
    path: string;
    kind: string;
    additions: number;
    deletions: number;
  }>;
  restoreAvailable?: boolean;
  restoreUnavailableReason?: string | null;
};

/** The part of a `get_history_entry` transaction record the diff view reads. */
type TransactionRecord = { id: string; changes: DiffFileChange[] };

/** Which record the timeline shows: git versions, Lattice's own activity, or Overleaf's history. */
type HistoryView = "versions" | "activity" | "overleaf";
type ActivityFilter = "all" | "user" | "agent" | "citation";

// Session-scoped memory of the last-used view. Versions is the default; the
// choice is intentionally not persisted to localStorage.
let lastUsedView: HistoryView = "versions";

/** One line of the timeline, whichever record it came from. */
type TimelineRow =
  | { kind: "activity"; key: string; at: number; item: HistoryItem }
  | { kind: "version"; key: string; at: number; entry: GitLogEntry }
  | { kind: "automatic"; key: string; at: number; entries: GitLogEntry[] }
  | { kind: "overleaf"; key: string; at: number; update: OverleafUpdate };

/** Runs of two or more automatic versions in a row become one folded line. */
function foldAutomatic(rows: TimelineRow[]): TimelineRow[] {
  const folded: TimelineRow[] = [];
  for (const row of rows) {
    const last = folded.at(-1);
    const automatic = row.kind === "version" && isAutomaticVersion(row.entry.message);
    if (automatic && last?.kind === "automatic") last.entries.push(row.entry);
    else if (automatic && last?.kind === "version" && isAutomaticVersion(last.entry.message)) {
      folded[folded.length - 1] = { kind: "automatic", key: `fold:${last.entry.hash}`, at: last.at, entries: [last.entry, row.entry] };
    } else folded.push(row);
  }
  return folded;
}

/** The actor glyph in an activity row's gutter. */
const ACTOR_GLYPHS: Record<string, typeof PenLine> = { user: PenLine, agent: Sparkles, citation: BookMarked, system: ArrowDownUp };

export function HistoryDrawer(props: {
  history: HistoryItem[];
  onClose: () => void;
  onRevert: (item: HistoryItem) => void;
  onRevertFile?: (id: string, path: string) => void;
  onDelete: (id: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onVersionsChanged?: () => void | Promise<void>;
  /** Overleaf keeps its own history server-side; offer it only when linked. */
  overleafLinked?: boolean;
  /** Root captured with the Overleaf link, used to scope every history action. */
  overleafProjectRoot?: string;
  /** After a restore on Overleaf's side, which leaves the local files untouched. */
  onOverleafRestored?: () => void;
}) {
  const { i18n, t } = useLingui();
  // A project that was linked last time may not be now, and the remembered view
  // would otherwise land on an Overleaf list with nothing behind it.
  const [view, setView] = useState<HistoryView>(
    lastUsedView === "overleaf" && !props.overleafLinked ? "versions" : lastUsedView,
  );
  const userPickedView = useRef(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const entryLoad = useLatestLoad<TransactionRecord>();
  const entry = entryLoad.value;
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const activeChangeIndexRef = useRef(0);
  useEffect(() => {
    activeChangeIndexRef.current = activeChangeIndex;
  }, [activeChangeIndex]);

  const versions = useGitVersions({
    projectRoot: props.overleafProjectRoot,
    onVersionsChanged: props.onVersionsChanged,
    onGitUnreachable: () => {
      // The git commands are missing entirely (e.g. an older backend build).
      // If the user hasn't picked a view themselves, fall back to Activity so
      // the drawer stays useful.
      if (userPickedView.current) return;
      lastUsedView = "activity";
      setView("activity");
    },
  });

  const selectView = (next: HistoryView) => {
    userPickedView.current = true;
    lastUsedView = next;
    setView(next);
  };

  const toggleRow = (key: string) => setExpandedKey((current) => (current === key ? null : key));
  const toggleActivity = (item: HistoryItem) => {
    setActiveChangeIndex(0);
    const expanding = expandedKey !== `activity:${item.id}`;
    setExpandedKey(expanding ? `activity:${item.id}` : null);
    if (expanding && item.kind !== "agent-checkpoint") {
      entryLoad.load(item.id, () => invoke<TransactionRecord>("get_history_entry", { transactionId: item.id }));
    } else entryLoad.clear();
  };

  // Asked to open on an entry (a revision round's): show the activity with it expanded.
  const focusEntry = useSyncExternalStore(subscribeHistoryFocus, historyFocus);
  const focusNonce = focusEntry?.nonce;
  const focusId = focusEntry?.id;
  const handledFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNonce || !focusId || handledFocusRef.current === focusNonce) return;
    handledFocusRef.current = focusNonce;
    lastUsedView = "activity";
    setView("activity");
    setFilter("all");
    setActiveChangeIndex(0);
    setExpandedKey(`activity:${focusId}`);
    entryLoad.load(focusId, () => invoke<TransactionRecord>("get_history_entry", { transactionId: focusId }));
    requestAnimationFrame(() => document.querySelector(`[data-history-entry="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: "start" }));
  }, [entryLoad, focusId, focusNonce]);

  const changePaths = useMemo(() => entry?.changes.map((change) => change.path) ?? [], [entry]);
  const resources = usePierreResources(changePaths);
  const { theme, themeName } = resources;
  const { onClose, onOpenFile } = props;
  const codeViewItems = useMemo<CodeViewItem<undefined>[]>(() => entry?.changes.map((change, index) => {
    const id = `history:${entry.id}:${index}`;
    return { id, type: "diff", fileDiff: pierreFileDiff(change, pierreLanguageForPath(change.path), id), version: 1 };
  }) ?? [], [entry]);
  const syncActiveChangeFromViewport = useCallback((
    scrollTop: number,
    viewer: { getTopForItem: (id: string) => number | undefined },
  ) => {
    if (!codeViewItems.length) return;
    const visibleIndex = topVisibleIndex(codeViewItems.map((item) => item.id), scrollTop, viewer);
    setActiveChangeIndex((current) => current === visibleIndex ? current : visibleIndex);
  }, [codeViewItems]);
  const codeViewOptions = useMemo(() => ({
    ...pierreCodeViewOptions({ theme, themeName }, 8),
    onLineClick: onOpenFile
      ? ({ lineNumber }: { lineNumber: number }, context: { item: CodeViewItem<undefined> }) => {
          if (context.item.type !== "diff") return;
          onOpenFile(context.item.fileDiff.name, lineNumber);
          onClose();
        }
      : undefined,
  }), [onClose, onOpenFile, theme, themeName]);
  const scrollToChange = (id: string) => codeViewRef.current?.scrollTo({ type: "item", id, align: "start", behavior: "smooth" });
  useEffect(() => {
    if (view !== "activity" || !resources.ready || !entry || entry.changes.length < 2) return;
    const activeItem = codeViewItems[activeChangeIndexRef.current];
    if (activeItem) scrollToChange(activeItem.id);
  }, [codeViewItems, entry, resources.ready, view]);
  const openLine = props.onOpenFile
    ? (path: string, line: number) => {
        props.onOpenFile?.(path, line);
        props.onClose();
      }
    : undefined;

  const renderTransaction = (item: HistoryItem, record: TransactionRecord) => {
    const [single] = record.changes.length === 1 ? record.changes : [];
    if (single) {
      return (
        <>
          <HistoryDiff key={`${item.id}:${single.path}`} change={single} onOpenLine={openLine} />
          {props.onRevertFile && (
            <div className="version-actions">
              <button
                type="button"
                className="version-action"
                title={t`Restore only ${single.path}`}
                onClick={() => props.onRevertFile?.(item.id, single.path)}
              >
                <RotateCcw size={12} /> {t`Restore this file`}
              </button>
            </div>
          )}
        </>
      );
    }
    if (!record.changes.length) return null;
    return (
      <>
        <div className="history-file-tabs" role="group" aria-label={t`Files in this change`}>
          {record.changes.map((change, index) => (
            <button
              key={`${change.path}:${index}`}
              type="button"
              className={`version-file${index === activeChangeIndex ? " active" : ""}`}
              aria-pressed={index === activeChangeIndex}
              onClick={() => {
                scrollToChange(`history:${record.id}:${index}`);
                setActiveChangeIndex(index);
              }}
            >
              <span>{change.path}</span>
            </button>
          ))}
        </div>
        <div className="history-code-view-shell">
          {resources.error ? (
            <p className="history-diff-error" role="alert">{t`Could not render these changes: ${resources.error.message}`}</p>
          ) : !resources.ready ? (
            <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Rendering changes…`}</p>
          ) : (
            <CodeView
              ref={codeViewRef}
              items={codeViewItems}
              options={codeViewOptions}
              className="history-code-view"
              disableWorkerPool
              onScroll={syncActiveChangeFromViewport}
              renderHeaderMetadata={(codeItem) => {
                const change = record.changes[codeViewItems.findIndex((candidate) => candidate.id === codeItem.id)];
                return change ? (
                  <span className="history-code-view-metadata">
                    <span className="history-code-view-kind"><ChangeKindLabel change={change} /></span>
                    {props.onRevertFile && (
                      <button
                        type="button"
                        className="history-code-view-restore"
                        title={t`Restore only ${change.path}`}
                        aria-label={t`Restore only ${change.path}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onRevertFile?.(item.id, change.path);
                        }}
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                ) : null;
              }}
            />
          )}
        </div>
      </>
    );
  };

  const actorLabels: Record<string, string> = { agent: t`Agent`, citation: t`Citation tool`, system: "Lattice" };
  const renderActivity = (item: HistoryItem, at: number, source?: string) => {
    const key = `activity:${item.id}`;
    const expanded = expandedKey === key;
    const actor = item.actor ?? "user";
    const Glyph = ACTOR_GLYPHS[actor] ?? PenLine;
    const restoreTitle = item.restoreAvailable === false
      ? item.restoreUnavailableReason || t`Open this Agent task before restoring its files`
      : item.kind === "agent-checkpoint"
        ? t`Undo this Agent turn's file changes`
        : t`Restore the state before this change`;
    const additions = item.fileSummaries?.reduce((sum, file) => sum + file.additions, 0) ?? 0;
    const deletions = item.fileSummaries?.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
    return (
      <HistoryRow
        key={key}
        data-history-entry={item.id}
        glyph={<Glyph size={13} strokeWidth={1.75} />}
        tone={actor}
        title={item.label}
        meta={(
          <>
            <span className="history-row-actor">{actorLabels[actor] ?? t`You`}</span>
            {item.files.length > 0 && <span className="history-row-detail">{item.files.join(", ")}</span>}
            <HistoryStat additions={additions} deletions={deletions} format={formatCount} />
          </>
        )}
        time={clockTime(at, i18n.locale)}
        timeTitle={fullTime(at, i18n.locale)}
        source={source}
        expanded={expanded}
        onToggle={() => toggleActivity(item)}
        tools={(
          <>
            <button
              type="button"
              className="history-tool"
              title={restoreTitle}
              aria-label={restoreTitle}
              disabled={item.restoreAvailable === false}
              onClick={() => props.onRevert(item)}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
            {item.kind !== "agent-checkpoint" && (
              <DestructiveButton className="history-tool history-tool-danger" title={t`Delete this history entry`} iconSize={13} onClick={() => props.onDelete(item.id)} />
            )}
          </>
        )}
      >
        <div className="history-entry-preview">
          {entryLoad.loading && entryLoad.key === item.id && <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>}
          {entryLoad.error && entryLoad.key === item.id && <p className="history-diff-error" role="alert">{entryLoad.error}</p>}
          {item.kind === "agent-checkpoint" && (
            <div className="history-checkpoint-summary">
              {item.threadTitle && <strong>{t`Agent task: ${item.threadTitle}`}</strong>}
              {item.fileSummaries?.map((file) => (
                <div key={file.path}>
                  <span>{file.path}</span>
                  <small>
                    {file.kind}
                    {file.additions || file.deletions
                      ? ` · +${file.additions} −${file.deletions}`
                      : ""}
                  </small>
                </div>
              ))}
            </div>
          )}
          {entry?.id === item.id && renderTransaction(item, entry)}
        </div>
      </HistoryRow>
    );
  };

  /** The rows of `view`'s record, newest first, grouped by day with automatic versions folded. */
  const renderTimeline = (rows: TimelineRow[], overleaf: OverleafHistory | null) => {
    const sorted = [...rows].sort((left, right) => right.at - left.at);
    return groupByDay(sorted, (row) => row.at).map((day) => (
      <HistoryDay key={day.key} label={dayName(day.at, i18n.locale)}>
        {foldAutomatic(day.items).flatMap((row): ReactNode[] => {
          switch (row.kind) {
            case "activity":
              return [renderActivity(row.item, row.at)];
            case "version":
              return [renderVersion(row.entry, versions)];
            case "automatic": {
              const open = openFolds.has(row.key);
              const toggle = () => setOpenFolds((current) => {
                const next = new Set(current);
                if (!next.delete(row.key)) next.add(row.key);
                return next;
              });
              return [
                <AutomaticVersionsRow key={row.key} entries={row.entries} open={open} onToggle={toggle} />,
                ...(open ? row.entries.map((entry) => renderVersion(entry, versions)) : []),
              ];
            }
            case "overleaf":
              return overleaf ? [renderOverleaf(row.update, overleaf)] : [];
          }
        })}
      </HistoryDay>
    ));
  };
  const renderVersion = (entry: GitLogEntry, git: GitVersions) => (
    <VersionRow
      key={`version:${entry.hash}`}
      entry={entry}
      versions={git}
      expanded={expandedKey === `version:${entry.hash}`}
      onToggle={() => toggleRow(`version:${entry.hash}`)}
    />
  );
  const renderOverleaf = (update: OverleafUpdate, overleaf: OverleafHistory) => (
    <OverleafHistoryRow
      key={`overleaf:${update.toVersion}`}
      update={update}
      history={overleaf}
      projectRoot={props.overleafProjectRoot ?? ""}
      expanded={expandedKey === `overleaf:${update.toVersion}`}
      onToggle={() => toggleRow(`overleaf:${update.toVersion}`)}
      onClose={props.onClose}
      onOpenFile={props.onOpenFile}
      onRestored={props.onOverleafRestored}
    />
  );

  const visibleHistory = props.history.filter((item) => filter === "all" || (item.actor ?? "user") === filter);
  const activityRows = (): TimelineRow[] => visibleHistory.map((item) => ({
    kind: "activity", key: `activity:${item.id}`, at: new Date(item.timestamp).getTime(), item,
  }));
  const versionRows = (): TimelineRow[] => (versions.phase === "ready" ? versions.entries : []).map((entry) => ({
    kind: "version", key: `version:${entry.hash}`, at: new Date(entry.timestamp).getTime(), entry,
  }));
  const overleafRows = (overleaf: OverleafHistory): TimelineRow[] => overleaf.updates.map((update) => ({
    kind: "overleaf", key: `overleaf:${update.toVersion}`, at: update.endTs, update,
  }));

  return (
    <ResizableDrawer className="project-history-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<History size={16} />}
          title={t`Project history`}
          onClose={props.onClose}
        />
        <ScrollArea
          className="project-history-scroll"
          fadeEdges={false}
          viewportClassName="project-history-scroll-viewport"
          viewportProps={{ "aria-label": t`Project history content` }}
        >
        <SlidingTabs
          value={view}
          onChange={(next) => selectView(next as HistoryView)}
          ariaLabel={t`History views`}
          variant="none"
          className="versions-tabs drawer-view-tabs"
          tabClassName="drawer-view-tab"
          items={[
            { value: "versions", label: t`Versions` },
            // Lattice's own change log (动态): not "Changes", which reads 修订 and means Overleaf's suggestions.
            { value: "activity", label: t({ message: "Activity", context: "history tab" }) },
            ...(props.overleafLinked ? [{ value: "overleaf", label: "Overleaf" }] : []),
          ]}
        />
        {view === "versions" && (
          <>
            <VersionsToolbar versions={versions}>
              {versions.phase === "ready" && versions.entries.length > 0 && (
                <span className="versions-count">
                  {versions.entries.length === 1 ? t`1 version` : t`${formatCount(versions.entries.length)} versions`}
                </span>
              )}
            </VersionsToolbar>
            <VersionsState versions={versions} />
            <div className="history-timeline">{renderTimeline(versionRows(), null)}</div>
          </>
        )}
        {view === "overleaf" && props.overleafLinked && (
          <OverleafHistorySource projectRoot={props.overleafProjectRoot ?? ""}>
            {(overleaf) => (
              <>
                <OverleafHistoryState history={overleaf} alone />
                <div className="history-timeline">{renderTimeline(overleafRows(overleaf), overleaf)}</div>
                {overleaf.hasMore && (
                  <button type="button" className="history-load-more" disabled={overleaf.loadingMore} onClick={() => void overleaf.loadMore()}>
                    {overleaf.loadingMore && <InfinityLoader size={12} />} {t`Load more`}
                  </button>
                )}
              </>
            )}
          </OverleafHistorySource>
        )}
        {view === "activity" && (
          <>
            <div className="ui-segmented ui-segmented--compact history-filters" role="group" aria-label={t`Filter project changes`}>
              {([
                ["all", t`All`],
                ["user", t`You`],
                ["agent", t`Agent`],
                ["citation", t`Citations`],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className="ui-segmented-tab"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="history-timeline">{renderTimeline(activityRows(), null)}</div>
            {!visibleHistory.length && (
              props.history.length ? (
                <EmptyState icon={<EmptyIllustration kind="search" />} description={t`No changes match this filter`} />
              ) : (
                <EmptyState
                  className="history-empty"
                  icon={<ResearchArt drawing={DATED_DRAFTS} />}
                  title={t`Nothing has changed yet`}
                  description={t`Every edit you, the agent or the citation tool make shows here, and each can be undone`}
                />
              )
            )}
          </>
        )}
        </ScrollArea>
    </ResizableDrawer>
  );
}

/** Overleaf's history read for the linked project; its hook only runs while a view needs it. */
function OverleafHistorySource(props: { projectRoot: string; children: (history: OverleafHistory) => ReactNode }) {
  const history = useOverleafHistory(props.projectRoot);
  return <>{props.children(history)}</>;
}
