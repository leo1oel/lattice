import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, History, RotateCcw } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { VersionsTimeline, versionsTimelineCss } from "./versions-timeline";
import { OverleafHistoryPanel } from "../overleaf/overleaf-history";
import { SlidingTabs } from "../components/ui/motion";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
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

type HistoryTab = "changes" | "versions" | "overleaf";
type HistoryFilter = "all" | "user" | "agent" | "citation";

// Session-scoped memory of the last-used tab. "Versions" is the default; the
// choice is intentionally not persisted to localStorage.
let lastUsedTab: HistoryTab = "versions";

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
  const { t } = useLingui();
  // A project that was linked last time may not be now, and the remembered tab
  // would otherwise land on an Overleaf panel with nothing behind it.
  const [tab, setTab] = useState<HistoryTab>(
    lastUsedTab === "overleaf" && !props.overleafLinked ? "versions" : lastUsedTab,
  );
  const userPickedTab = useRef(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const entryLoad = useLatestLoad<TransactionRecord>();
  const entry = entryLoad.value;
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const activeChangeIndexRef = useRef(0);
  useEffect(() => {
    activeChangeIndexRef.current = activeChangeIndex;
  }, [activeChangeIndex]);

  const selectTab = (next: HistoryTab) => {
    userPickedTab.current = true;
    lastUsedTab = next;
    setTab(next);
  };

  const toggleEntry = (item: HistoryItem) => {
    setActiveChangeIndex(0);
    const expanding = expandedId !== item.id;
    setExpandedId(expanding ? item.id : null);
    if (expanding && item.kind !== "agent-checkpoint") {
      entryLoad.load(item.id, () => invoke<TransactionRecord>("get_history_entry", { transactionId: item.id }));
    } else entryLoad.clear();
  };

  const changePaths = useMemo(() => entry?.changes.map((change) => change.path) ?? [], [entry]);
  const resources = usePierreResources(changePaths);
  const { theme, themeName } = resources;
  const { onClose, onOpenFile } = props;
  const codeViewItems = useMemo<CodeViewItem[]>(() => entry?.changes.map((change, index) => {
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
      ? ({ lineNumber }: { lineNumber: number }, context: { item: CodeViewItem }) => {
          if (context.item.type !== "diff") return;
          onOpenFile(context.item.fileDiff.name, lineNumber);
          onClose();
        }
      : undefined,
  }), [onClose, onOpenFile, theme, themeName]);
  const scrollToChange = (id: string) => codeViewRef.current?.scrollTo({ type: "item", id, align: "start", behavior: "smooth" });
  useEffect(() => {
    if (tab !== "changes" || !resources.ready || !entry || entry.changes.length < 2) return;
    const activeItem = codeViewItems[activeChangeIndexRef.current];
    if (activeItem) scrollToChange(activeItem.id);
  }, [codeViewItems, entry, resources.ready, tab]);
  const visibleHistory = props.history.filter((item) => filter === "all" || (item.actor ?? "user") === filter);
  const actorLabels: Record<string, string> = { agent: t`Agent`, citation: t`Citation tool`, system: "Lattice" };
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
            <button
              type="button"
              className="history-restore-file"
              title={t`Restore only ${single.path}`}
              onClick={() => props.onRevertFile?.(item.id, single.path)}
            >
              <RotateCcw size={12} /> {t`Restore this file`}
            </button>
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
              className={`ui-compact-selectable${index === activeChangeIndex ? " active" : ""}`}
              aria-pressed={index === activeChangeIndex}
              onClick={() => {
                scrollToChange(`history:${record.id}:${index}`);
                setActiveChangeIndex(index);
              }}
            >
              {change.path}
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

  return (
    <ResizableDrawer className="project-history-drawer" onClose={props.onClose}>
        <style>{versionsTimelineCss}</style>
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
          value={tab}
          onChange={(next) => selectTab(next as HistoryTab)}
          ariaLabel={t`History views`}
          variant="none"
          className="versions-tabs drawer-view-tabs"
          tabClassName="drawer-view-tab"
          items={[
            { value: "changes", label: t`Changes` },
            { value: "versions", label: t`Versions` },
            ...(props.overleafLinked ? [{ value: "overleaf", label: "Overleaf" }] : []),
          ]}
        />
        {tab === "overleaf" && props.overleafLinked && (
          <OverleafHistoryPanel
            projectRoot={props.overleafProjectRoot ?? ""}
            onClose={props.onClose}
            onOpenFile={props.onOpenFile}
            onRestored={props.onOverleafRestored}
          />
        )}
        {tab === "versions" && (
          <VersionsTimeline
            projectRoot={props.overleafProjectRoot}
            onVersionsChanged={props.onVersionsChanged}
            onGitUnreachable={() => {
              // The git commands are missing entirely (e.g. an older backend
              // build). If the user hasn't picked a tab themselves, fall back
              // to the Changes tab so the drawer stays useful.
              if (userPickedTab.current) return;
              lastUsedTab = "changes";
              setTab("changes");
            }}
          />
        )}
        {tab === "changes" && (
          <>
            <div className="history-filters" role="group" aria-label={t`Filter project changes`}>
              {([
                ["all", t`All`],
                ["user", t`You`],
                ["agent", t`Agent`],
                ["citation", t`Citations`],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={`ui-compact-selectable${filter === value ? " active" : ""}`}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="history-list">
              {visibleHistory.map((item) => {
                const expanded = expandedId === item.id;
                const restoreTitle = item.restoreAvailable === false
                  ? item.restoreUnavailableReason || t`Open this Agent task before restoring its files`
                  : item.kind === "agent-checkpoint"
                    ? t`Undo this Agent turn's file changes`
                    : t`Restore the state before this change`;
                return (
                  <div className={`history-item ${expanded ? "expanded" : ""}`} key={item.id}>
                    <div className="history-body">
                      <button
                        type="button"
                        className="history-expand"
                        aria-expanded={expanded}
                        onClick={() => toggleEntry(item)}
                      >
                        <strong>{item.label}</strong>
                        <span>
                          <span className={`history-actor ${item.actor ?? "user"}`}>{actorLabels[item.actor ?? ""] ?? t`You`}</span>
                          <Clock3 size={11} /> {new Date(item.timestamp).toLocaleString()}
                        </span>
                        <p>{item.files.join(", ")}</p>
                      </button>
                      {expanded && (
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
                      )}
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        title={restoreTitle}
                        disabled={item.restoreAvailable === false}
                        onClick={() => props.onRevert(item)}
                      >
                        <RotateCcw size={14} />
                      </button>
                      {item.kind !== "agent-checkpoint" && (
                        <DestructiveButton
                          className="history-delete"
                          title={t`Delete this history entry`}
                          iconSize={13}
                          onClick={() => props.onDelete(item.id)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              {!visibleHistory.length && (
                <EmptyState
                  icon={<EmptyIllustration kind={props.history.length ? "search" : "history"} />}
                  description={props.history.length ? t`No changes match this filter` : t`No changes recorded yet`}
                />
              )}
            </div>
          </>
        )}
        </ScrollArea>
    </ResizableDrawer>
  );
}
