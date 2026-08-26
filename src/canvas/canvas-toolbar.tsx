import {
  BookOpen,
  ChevronDown,
  Cloud,
  Columns2,
  ExternalLink,
  FileCode2,
  Image,
  MessagesSquare,
  Omega,
  PanelRightClose,
  Redo2,
  Undo2,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Tip } from "../components/icon-tip";
import { type CanvasMode, type DocumentViewMode } from "../app-types";
import { AnimatedProductIcon } from "../animated-icons/product-animated-icon";
import { InfinityLoader } from "../components/ui/activity-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SegmentedControl } from "../components/ui/segmented-control";

/**
 * What the cloud button says when this file is not live.
 *
 * The live channel either carries the open document or it doesn't, and when it
 * doesn't the reason matters — silently falling back to syncing looks exactly
 * like the feature being broken.
 */
function overleafChannelLabel(
  channel: "off" | "connecting" | "live" | "error" | undefined,
  detail: string | null | undefined,
  labels: {
    connecting: string;
    error: (detail: string | null | undefined) => string;
    live: string;
    liveDetail: string;
    sync: string;
  },
) {
  if (channel === "connecting") {
    return detail || labels.connecting;
  }
  if (channel === "error") {
    return labels.error(detail);
  }
  if (channel === "live") {
    return detail ? `${detail} · ${labels.liveDetail}` : labels.live;
  }
  return labels.sync;
}

type CanvasToolbarProps = {
  mode: CanvasMode;
  selectedDocumentViewMode?: DocumentViewMode;
  setMode: (mode: DocumentViewMode) => void;
  supportsDocumentViewModes: boolean;
  onSplit?: () => void;
  onCloseSplit?: () => void;
  markdown: boolean;
  html: boolean;
  presentation?: boolean;
  paperView?: "blog" | "fulltext";
  paperHasBlog?: boolean;
  paperHasFullText?: boolean;
  onPaperView?: (view: "blog" | "fulltext") => void;
  activePath: string;
  activeKind: "document" | "paper" | "asset";
  canInsert: boolean;
  dirty: boolean;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onInsert: () => void;
  onCollab: () => void;
  collabLive: boolean;
  collabPeers: number;
  /** Collaboration presence avatars, rendered beside the live control. */
  collabPresence?: ReactNode;
  onHistory: () => void;
  onGit: () => void;
  commentCount: number;
  onComments: () => void;
  overleafLinked?: boolean;
  overleafSyncing?: boolean;
  /** Manual mode only: Overleaf has work you have not taken yet. */
  overleafPending?: boolean;
  /** True while this file is being edited through Overleaf's live channel. */
  overleafLiveEditing?: boolean;
  /** State of that channel, so a failure to start is visible rather than silent. */
  overleafChannel?: "off" | "connecting" | "live" | "error";
  /** Why the channel is not carrying this file, when there is a reason. */
  overleafChannelDetail?: string | null;
  onOverleafSync?: () => void;
  /** Name shown atop the linked-project actions menu. */
  overleafProjectName?: string;
  /** Open the linked project in Overleaf's web interface. */
  onOverleafOpenCurrent?: () => void;
  /** Browse projects in the connected Overleaf account. */
  onOverleafOpen?: () => void;
  /** Open comments plus unread chat: what is waiting on you in the project. */
  overleafUnreadChat?: number;
  onOverleafChat?: () => void;
  /** Where the Overleaf presence avatars go; kept as a slot so this file need
   *  not know anything about who is in the project. */
  overleafPresence?: ReactNode;
};

const CanvasToolbarView = memo(function CanvasToolbarView(props: CanvasToolbarProps) {
  const { t } = useLingui();
  const ActiveIcon = props.activeKind === "asset" ? Image : props.activeKind === "paper" ? BookOpen : FileCode2;
  // Two editable files are still an Edit view. "Split" in this control has
  // always meant source + rendered preview, so marking a dual editor as Split
  // left no visible way to bring the compiled PDF back beside the source.
  const switcherMode = props.selectedDocumentViewMode
    ?? (props.mode === "dual" || props.mode === "columns" ? "source" : props.mode);
  const showOverleafOnline = Boolean(props.overleafLinked && (
    props.overleafSyncing || props.overleafLiveEditing || props.overleafChannel === "live"
  ));
  return (
    <div className="canvas-toolbar">
      <div className="active-document"><ActiveIcon size={14} /><span>{props.activePath}</span>{props.activeKind === "document" && props.dirty && <i />}</div>
      <div className="canvas-mode-controls" data-tour="document-view">
        {props.supportsDocumentViewModes ? (
          <SegmentedControl
            value={switcherMode}
            onChange={(mode) => {
              if (mode === "source" || mode === "split" || mode === "pdf") props.setMode(mode);
            }}
            ariaLabel={t`Document view`}
            className="canvas-view-switcher"
            items={[
              {
                value: "source",
                label: t`Edit`,
                title: props.presentation
                  ? t`Edit presentation source`
                  : props.markdown
                    ? t`Edit Markdown`
                    : props.html
                      ? t`Edit HTML`
                      : t`Edit source`,
              },
              {
                value: "split",
                label: t`Split`,
                title: props.presentation
                  ? t`Edit and preview presentation`
                  : props.markdown
                    ? t`Edit and preview Markdown`
                    : props.html
                      ? t`Edit and preview HTML`
                      : t`Edit source and preview PDF`,
              },
              {
                value: "pdf",
                label: t`Preview`,
                title: props.presentation
                  ? t`Preview presentation`
                  : props.markdown
                    ? t`Preview Markdown`
                    : props.html
                      ? t`Preview HTML`
                      : t`Preview PDF`,
              },
            ]}
          />
        ) : null}
        {props.activeKind === "paper"
          && props.paperView
          && props.onPaperView
          && props.paperHasBlog
          && props.paperHasFullText && (
          <SegmentedControl
            value={props.paperView}
            onChange={props.onPaperView}
            ariaLabel={t`Paper content`}
            className="paper-content-switcher"
            items={[
              { value: "blog", label: t`Blog`, title: t`Open the paper overview`, dataTour: "paper-blog" },
              { value: "fulltext", label: t`Paper`, title: t`Open the full paper Markdown`, dataTour: "paper-fulltext" },
            ]}
          />
        )}
      </div>
      <div className="canvas-actions" data-tour="workspace-actions">
        {props.activeKind === "document" && (
          <>
            <Tip label={t`Go back (⌘[)`}>
              <button type="button" disabled={!props.canNavigateBack} onClick={props.onNavigateBack}>
                <Undo2 size={14} />
              </button>
            </Tip>
            <Tip label={t`Go forward (⌘])`}>
              <button type="button" disabled={!props.canNavigateForward} onClick={props.onNavigateForward}>
                <Redo2 size={14} />
              </button>
            </Tip>
          </>
        )}
        {props.onSplit && (
          <Tip label={t`Split editor right`}>
            <button type="button" onClick={props.onSplit}>
              <Columns2 size={14} />
            </button>
          </Tip>
        )}
        {props.onCloseSplit && (
          <Tip label={t`Close split`}>
            <button type="button" onClick={props.onCloseSplit}>
              <PanelRightClose size={14} />
            </button>
          </Tip>
        )}
        {props.activeKind === "document" && (
          <>
            {props.canInsert && <Tip label={t`Insert snippet or symbol (⌘⇧I)`}>
              <button type="button" onClick={props.onInsert}>
                <Omega size={14} />
              </button>
            </Tip>}
            <Tip label={t`Editor comments`}>
              <button
                type="button"
                className={props.commentCount ? "active" : ""}
                onClick={props.onComments}
              >
                <AnimatedProductIcon kind="chat" size={14} converted />
                {props.commentCount > 0 ? <em className="collab-peer-badge">{props.commentCount}</em> : null}
              </button>
            </Tip>
            <Tip label={props.collabLive
              ? (props.collabPeers > 0
                ? props.collabPeers === 1
                  ? t({ message: `Live · ${{ count: props.collabPeers }} other` })
                  : t({ message: `Live · ${{ count: props.collabPeers }} others` })
                : t`Live collaboration · just you`)
              : t`Live collaboration`}
            >
              <button
                type="button"
                data-tour="collaboration"
                className={props.collabLive ? "active collab-toolbar-button" : "collab-toolbar-button"}
                onClick={props.onCollab}
              >
                <AnimatedProductIcon source="provided" kind="radio" size={14} />
                {props.collabLive ? <em className="collab-peer-badge collab-live-badge">{props.collabPeers}</em> : null}
              </button>
            </Tip>
            {props.collabPresence}
          </>
        )}
        {(props.onOverleafSync || props.onOverleafOpen) && (
          <div className={props.overleafLinked ? "overleaf-toolbar-group" : undefined}>
            <Tip label={props.overleafLinked
              ? (props.overleafSyncing
                ? t`Syncing with Overleaf…`
                : props.overleafPending
                  ? t`New changes on Overleaf — click to bring them in`
                  : props.overleafLiveEditing
                    ? t`Editing live with Overleaf · click to sync everything else`
                    : overleafChannelLabel(props.overleafChannel, props.overleafChannelDetail, {
                      connecting: t`Connecting to Overleaf's live channel…`,
                      error: (detail) => detail
                        ? t({ message: `Live editing unavailable (${detail}) · syncing instead` })
                        : t`Live editing unavailable · syncing instead`,
                      live: t`Connected live · click to sync everything`,
                      liveDetail: t`click to sync`,
                      sync: t`Sync with Overleaf`,
                    }))
              : t`Open a project from Overleaf`}
            >
              <button
                data-tour="overleaf"
                className={props.overleafLinked
                  ? "history-button active overleaf-toolbar-primary"
                  : "history-button"}
                disabled={props.overleafSyncing}
                onClick={props.overleafLinked ? props.onOverleafSync : props.onOverleafOpen}
              >
                {props.overleafSyncing
                  ? <InfinityLoader size={14} />
                  : props.overleafLinked
                    ? <AnimatedProductIcon source="provided" kind="cloud-upload-outline" size={14} />
                    : <Cloud size={14} />}
                {showOverleafOnline
                  ? <em className="overleaf-status-dot" aria-hidden="true" />
                  : props.overleafPending && !props.overleafSyncing
                    ? <em className="collab-peer-badge">•</em>
                    : null}
              </button>
            </Tip>
            {props.overleafLinked && props.onOverleafOpenCurrent && props.onOverleafOpen && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="history-button active overleaf-toolbar-menu-button"
                    aria-label={t`Overleaf project actions`}
                    title={t`Overleaf project actions`}
                  >
                    <ChevronDown size={10} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-64">
                  {props.overleafProjectName && (
                    <>
                      <DropdownMenuLabel className="truncate" title={props.overleafProjectName}>
                        {props.overleafProjectName}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem
                    className="overleaf-toolbar-menu-item"
                    onSelect={props.onOverleafOpenCurrent}
                  >
                    <ExternalLink /> {t`Open in Overleaf`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="overleaf-toolbar-menu-item"
                    onSelect={props.onOverleafOpen}
                  >
                    <Cloud /> {t`Open another Overleaf project`}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
        {props.overleafLinked && props.onOverleafChat && (
          <Tip label={props.overleafUnreadChat
            ? t({ message: `Overleaf comments and chat · ${{ count: props.overleafUnreadChat }} waiting` })
            : t`Overleaf comments and chat`}
          >
            <button
              type="button"
              className={props.overleafUnreadChat ? "history-button active" : "history-button"}
              onClick={props.onOverleafChat}
            >
              <MessagesSquare size={14} />
              {props.overleafUnreadChat
                ? <em className="collab-peer-badge">{props.overleafUnreadChat}</em>
                : null}
            </button>
          </Tip>
        )}
        {props.overleafPresence}
        <Tip label={t`Git status and commit`}>
          <button className="history-button" data-tour="git" onClick={props.onGit}>
            <AnimatedProductIcon kind="git-branch" size={15} />
          </button>
        </Tip>
        <Tip label={t`Project history`}>
          <button className="history-button" onClick={props.onHistory}>
            <AnimatedProductIcon kind="clock-back" size={15} />
          </button>
        </Tip>
      </div>
    </div>
  );
});

/**
 * App rebuilds this toolbar's handlers inline on every render, and it renders
 * on every keystroke — so the toolbar was re-rendering constantly even though
 * nothing it displays had changed. The handlers below keep one identity for the
 * life of the component and forward to the newest props through a ref, which
 * lets the view memoize on the values it actually draws. Optional handlers stay
 * optional: the view reads their presence to decide what to render.
 */
export function CanvasToolbar(props: CanvasToolbarProps) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const stable = useMemo(() => ({
    setMode: (mode: DocumentViewMode) => latest.current.setMode(mode),
    onSplit: () => latest.current.onSplit?.(),
    onCloseSplit: () => latest.current.onCloseSplit?.(),
    onPaperView: (view: "blog" | "fulltext") => latest.current.onPaperView?.(view),
    onNavigateBack: () => latest.current.onNavigateBack(),
    onNavigateForward: () => latest.current.onNavigateForward(),
    onInsert: () => latest.current.onInsert(),
    onCollab: () => latest.current.onCollab(),
    onHistory: () => latest.current.onHistory(),
    onGit: () => latest.current.onGit(),
    onComments: () => latest.current.onComments(),
    onOverleafSync: () => latest.current.onOverleafSync?.(),
    onOverleafOpenCurrent: () => latest.current.onOverleafOpenCurrent?.(),
    onOverleafOpen: () => latest.current.onOverleafOpen?.(),
    onOverleafChat: () => latest.current.onOverleafChat?.(),
  }), []);
  return (
    <CanvasToolbarView
      {...props}
      setMode={stable.setMode}
      onSplit={props.onSplit ? stable.onSplit : undefined}
      onCloseSplit={props.onCloseSplit ? stable.onCloseSplit : undefined}
      onPaperView={props.onPaperView ? stable.onPaperView : undefined}
      onNavigateBack={stable.onNavigateBack}
      onNavigateForward={stable.onNavigateForward}
      onInsert={stable.onInsert}
      onCollab={stable.onCollab}
      onHistory={stable.onHistory}
      onGit={stable.onGit}
      onComments={stable.onComments}
      onOverleafSync={props.onOverleafSync ? stable.onOverleafSync : undefined}
      onOverleafOpenCurrent={props.onOverleafOpenCurrent ? stable.onOverleafOpenCurrent : undefined}
      onOverleafOpen={props.onOverleafOpen ? stable.onOverleafOpen : undefined}
      onOverleafChat={props.onOverleafChat ? stable.onOverleafChat : undefined}
    />
  );
}
