import { parseDiffFromFile, type CodeViewItem } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, History, RotateCcw } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { HistoryDiff, VersionsTimeline, versionsTimelineCss } from "./versions-timeline";
import { OverleafHistoryPanel } from "../overleaf/overleaf-history";
import { SlidingTabs } from "../components/ui/motion";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import {
  PIERRE_UNSAFE_CSS,
  pierreLanguageForPath,
  usePierreResources,
} from "./file-diff-view";
import { changeKind } from "./history-diff";

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

type FileChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

type TransactionRecord = {
  schemaVersion?: number;
  id: string;
  label: string;
  timestamp: string;
  actor?: string | null;
  kind?: string | null;
  source?: string | null;
  threadId?: string | null;
  checkpointRef?: string | null;
  undoOf?: string | null;
  changes: FileChange[];
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

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
  onVersionsChanged?: () => void;
  /** Overleaf keeps its own history server-side; offer it only when linked. */
  overleafLinked?: boolean;
  /** Root captured with the Overleaf link, used to scope every history action. */
  overleafProjectRoot?: string;
  /** After a restore on Overleaf's side, which leaves the local files untouched. */
  onOverleafRestored?: () => void;
}) {
  const { t } = useLingui();
  // `changeKind` returns the discriminant the CSS and tests key on, so the
  // display name is resolved here instead of at the source.
  const changeKindLabel: Record<ReturnType<typeof changeKind>, string> = {
    created: t`created`,
    deleted: t`deleted`,
    edited: t`edited`,
  };
  // A project that was linked last time may not be now, and the remembered tab
  // would otherwise land on an Overleaf panel with nothing behind it.
  const [tab, setTab] = useState<HistoryTab>(
    lastUsedTab === "overleaf" && !props.overleafLinked ? "versions" : lastUsedTab,
  );
  const userPickedTab = useRef(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<TransactionRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const activeChangeIndexRef = useRef(0);
  const entryRequestGeneration = useRef(0);
  useEffect(() => {
    activeChangeIndexRef.current = activeChangeIndex;
  }, [activeChangeIndex]);

  const selectTab = (next: HistoryTab) => {
    userPickedTab.current = true;
    lastUsedTab = next;
    setTab(next);
  };

  const toggleEntry = (item: HistoryItem) => {
    const requestGeneration = ++entryRequestGeneration.current;
    if (expandedId === item.id) {
      setExpandedId(null);
      setEntry(null);
      setActiveChangeIndex(0);
      setError("");
      setLoadingId(null);
      return;
    }
    setExpandedId(item.id);
    setEntry(null);
    setActiveChangeIndex(0);
    setError("");
    if (item.kind === "agent-checkpoint") {
      setLoadingId(null);
      return;
    }
    setLoadingId(item.id);
    void invoke<TransactionRecord>("get_history_entry", { transactionId: item.id })
      .then((record) => {
        if (entryRequestGeneration.current !== requestGeneration) return;
        setEntry(record);
        setActiveChangeIndex(0);
      })
      .catch((reason) => {
        if (entryRequestGeneration.current !== requestGeneration) return;
        setEntry(null);
        setError(message(reason));
      })
      .finally(() => {
        if (entryRequestGeneration.current === requestGeneration) setLoadingId(null);
      });
  };

  const activeChange = entry?.changes[activeChangeIndex] ?? entry?.changes[0] ?? null;
  const changePaths = useMemo(() => entry?.changes.map((change) => change.path) ?? [], [entry]);
  const resources = usePierreResources(changePaths);
  const { onClose, onOpenFile } = props;
  const codeViewItems = useMemo<CodeViewItem[]>(() => entry?.changes.map((change, index) => {
    const language = pierreLanguageForPath(change.path);
    const revisionKey = `history:${entry.id}:${index}`;
    const parsed = parseDiffFromFile(
      {
        name: change.path,
        contents: change.before ?? "",
        lang: language,
        cacheKey: `${revisionKey}:before`,
      },
      {
        name: change.path,
        contents: change.after ?? "",
        lang: language,
        cacheKey: `${revisionKey}:after`,
      },
    );
    const fileDiff = change.before == null
      ? { ...parsed, type: "new" as const }
      : change.after == null
        ? { ...parsed, type: "deleted" as const }
        : parsed;
    return { id: revisionKey, type: "diff", fileDiff, version: 1 };
  }) ?? [], [entry]);
  const syncActiveChangeFromViewport = useCallback((
    scrollTop: number,
    viewer: { getTopForItem: (id: string) => number | undefined },
  ) => {
    let visibleIndex: number | null = codeViewItems.length > 0 ? 0 : null;
    for (let index = 0; index < codeViewItems.length; index += 1) {
      const top = viewer.getTopForItem(codeViewItems[index]!.id);
      if (top == null) continue;
      if (top > scrollTop + 1) break;
      visibleIndex = index;
    }
    if (visibleIndex != null) {
      setActiveChangeIndex((current) => current === visibleIndex ? current : visibleIndex);
    }
  }, [codeViewItems]);
  const codeViewOptions = useMemo(() => ({
    diffStyle: "unified" as const,
    lineDiffType: "word" as const,
    overflow: "scroll" as const,
    stickyHeaders: true,
    theme: resources.themeName,
    themeType: resources.theme,
    unsafeCSS: PIERRE_UNSAFE_CSS,
    layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
    onLineClick: onOpenFile
      ? ({ lineNumber }: { lineNumber: number }, context: { item: CodeViewItem }) => {
          if (context.item.type !== "diff") return;
          onOpenFile(context.item.fileDiff.name, lineNumber);
          onClose();
        }
      : undefined,
  }), [onClose, onOpenFile, resources.theme, resources.themeName]);
  useEffect(() => {
    if (tab !== "changes" || !resources.ready || !entry || entry.changes.length < 2) return;
    const activeItem = codeViewItems[activeChangeIndexRef.current];
    if (!activeItem) return;
    codeViewRef.current?.scrollTo({
      type: "item",
      id: activeItem.id,
      align: "start",
      behavior: "smooth",
    });
  }, [codeViewItems, entry, resources.ready, tab]);
  const visibleHistory = props.history.filter((item) => {
    if (filter === "all") return true;
    return (item.actor ?? "user") === filter;
  });

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
                const actor = item.actor === "agent"
                  ? t`Agent`
                  : item.actor === "citation"
                    ? t`Citation tool`
                    : item.actor === "system"
                      ? "Lattice"
                      : t`You`;
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
                          <span className={`history-actor ${item.actor ?? "user"}`}>{actor}</span>
                          <Clock3 size={11} /> {new Date(item.timestamp).toLocaleString()}
                        </span>
                        <p>{item.files.join(", ")}</p>
                      </button>
                      {expanded && (
                        <div className="history-entry-preview">
                          {loadingId === item.id && <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>}
                          {error && expandedId === item.id && <p className="history-diff-error" role="alert">{error}</p>}
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
                          {entry && entry.id === item.id && (
                            <>
                              {entry.changes.length > 1 && (
                                <div className="history-file-tabs" role="group" aria-label={t`Files in this change`}>
                                  {entry.changes.map((change, index) => (
                                    <button
                                      key={`${change.path}:${index}`}
                                      type="button"
                                      className={`ui-compact-selectable${index === activeChangeIndex ? " active" : ""}`}
                                      aria-pressed={index === activeChangeIndex}
                                      onClick={() => {
                                        codeViewRef.current?.scrollTo({
                                          type: "item",
                                          id: `history:${entry.id}:${index}`,
                                          align: "start",
                                          behavior: "smooth",
                                        });
                                        setActiveChangeIndex(index);
                                      }}
                                    >
                                      {change.path}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {entry.changes.length === 1 && activeChange && (
                                <HistoryDiff
                                  key={`${item.id}:${activeChange.path}`}
                                  change={activeChange}
                                  onOpenLine={props.onOpenFile
                                    ? (path, line) => {
                                        props.onOpenFile?.(path, line);
                                        props.onClose();
                                      }
                                    : undefined}
                                />
                              )}
                              {entry.changes.length > 1 && (
                                <div className="history-code-view-shell">
                                  {resources.error ? (
                                    <p className="history-diff-error" role="alert">
                                      {t`Could not render these changes: ${resources.error.message}`}
                                    </p>
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
                                        const index = codeViewItems.findIndex((candidate) => candidate.id === codeItem.id);
                                        const change = entry.changes[index];
                                        return change ? (
                                          <span
                                            className="history-code-view-metadata"
                                          >
                                            <span className="history-code-view-kind">
                                              {changeKindLabel[changeKind(change.before, change.after)]}
                                            </span>
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
                              )}
                              {entry.changes.length === 1 && activeChange && props.onRevertFile && (
                                <button
                                  type="button"
                                  className="history-restore-file"
                                  title={t`Restore only ${activeChange.path}`}
                                  onClick={() => props.onRevertFile?.(item.id, activeChange.path)}
                                >
                                  <RotateCcw size={12} /> {t`Restore this file`}
                                </button>
                              )}
                            </>
                          )}
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
                <EmptyState description={props.history.length ? t`No changes match this filter.` : t`No changes recorded yet.`} />
              )}
            </div>
          </>
        )}
        </ScrollArea>
    </ResizableDrawer>
  );
}
