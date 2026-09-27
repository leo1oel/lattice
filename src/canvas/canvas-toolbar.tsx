import { BookOpen, ChevronDown, Cloud, Columns2, ExternalLink, FileCode2, Image, MessagesSquare, Omega, PanelRightClose } from "lucide-react";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Tip } from "../components/icon-tip";
import { type CanvasMode, type DocumentViewMode } from "../app-types";
import { AnimatedProductIcon } from "../animated-icons/product-animated-icon";
import { isCollabEnabled } from "../collab/collab-feature-policy";
import { InfinityLoader } from "../components/ui/activity-icons";
import { StateSwap } from "../components/ui/motion";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SegmentedControl } from "../components/ui/segmented-control";

type CanvasToolbarProps = {
  mode: CanvasMode;
  selectedDocumentViewMode?: DocumentViewMode;
  setMode: (mode: DocumentViewMode) => void;
  supportsDocumentViewModes: boolean;
  onSplit?: () => void;
  onCloseSplit?: () => void;
  markdown: boolean;
  html: boolean;
  paperView?: "blog" | "fulltext";
  paperHasBlog?: boolean;
  paperHasFullText?: boolean;
  onPaperView?: (view: "blog" | "fulltext") => void;
  activePath: string;
  activeKind: "document" | "paper" | "asset";
  canInsert: boolean;
  dirty: boolean;
  onInsert: () => void;
  onCollab: () => void;
  collabLive: boolean;
  collabPeers: number;
  /** Collaboration presence avatars, rendered beside the live control. */
  collabPresence?: ReactNode;
  onHistory: () => void;
  onPaperLookup?: () => void;
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
  const showOverleafOnline = Boolean(props.overleafLinked)
    && Boolean(props.overleafSyncing || props.overleafLiveEditing || props.overleafChannel === "live");
  const [editTitle, splitTitle, previewTitle] = props.markdown
    ? [t`Edit Markdown`, t`Edit and preview Markdown`, t`Preview Markdown`]
    : props.html
      ? [t`Edit HTML`, t`Edit and preview HTML`, t`Preview HTML`]
      : [t`Edit source`, t`Edit source and preview PDF`, t`Preview PDF`];
  const overleafLabel = () => {
    if (!props.overleafLinked) return t`Open a project from Overleaf`;
    if (props.overleafSyncing) return t`Syncing with Overleaf…`;
    if (props.overleafPending) return t`New changes on Overleaf — click to bring them in`;
    if (props.overleafLiveEditing) return t`Editing live with Overleaf · click to sync everything else`;
    // When this file is not live, say why: silently falling back to syncing
    // looks exactly like the feature being broken.
    const detail = props.overleafChannelDetail;
    switch (props.overleafChannel) {
      case "connecting": return detail || t`Connecting to Overleaf's live channel…`;
      case "error": return detail
        ? t({ message: `Live editing unavailable (${detail}) · syncing instead` })
        : t`Live editing unavailable · syncing instead`;
      case "live": return detail ? `${detail} · ${t`click to sync`}` : t`Connected live · click to sync everything`;
      default: return t`Sync with Overleaf`;
    }
  };
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
              { value: "source", label: t`Edit`, title: editTitle },
              { value: "split", label: t`Split`, title: splitTitle },
              { value: "pdf", label: t`Preview`, title: previewTitle },
            ]}
          />
        ) : null}
        {props.activeKind === "paper" && props.paperView && props.onPaperView && props.paperHasBlog && props.paperHasFullText && (
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
        {props.onSplit && (
          <Tip label={t`Split editor right`}>
            <button type="button" onClick={props.onSplit}><Columns2 size={14} /></button>
          </Tip>
        )}
        {props.onCloseSplit && (
          <Tip label={t`Close split`}>
            <button type="button" onClick={props.onCloseSplit}><PanelRightClose size={14} /></button>
          </Tip>
        )}
        {props.activeKind === "document" && (
          <>
            {props.canInsert && <Tip label={t`Insert snippet or symbol (⌘⇧I)`}>
              <button type="button" onClick={props.onInsert}><Omega size={14} /></button>
            </Tip>}
            {!props.overleafLinked && <Tip label={t`Editor comments`}>
              <button type="button" className={props.commentCount ? "active" : ""} onClick={props.onComments}>
                <AnimatedProductIcon kind="chat" size={14} converted />
                {props.commentCount > 0 ? <em className="collab-peer-badge">{props.commentCount}</em> : null}
              </button>
            </Tip>}
            {isCollabEnabled() && <Tip label={props.collabLive
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
            </Tip>}
            {isCollabEnabled() && props.collabPresence}
          </>
        )}
        {(props.onOverleafSync || props.onOverleafOpen) && (
          <div className={props.overleafLinked ? "overleaf-toolbar-group" : undefined}>
            <Tip label={overleafLabel()}>
              <button
                data-tour="overleaf"
                className={props.overleafLinked
                  ? "history-button active overleaf-toolbar-primary"
                  : "history-button"}
                disabled={props.overleafSyncing}
                onClick={props.overleafLinked ? props.onOverleafSync : props.onOverleafOpen}
              >
                <StateSwap swapKey={props.overleafSyncing ? "syncing" : props.overleafLinked ? "linked" : "unlinked"}>
                  {props.overleafSyncing
                    ? <InfinityLoader size={14} />
                    : props.overleafLinked
                      ? <AnimatedProductIcon source="provided" kind="cloud-upload-outline" size={14} />
                      : <Cloud size={14} />}
                </StateSwap>
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
                  <DropdownMenuItem className="overleaf-toolbar-menu-item" onSelect={props.onOverleafOpenCurrent}>
                    <ExternalLink /> {t`Open in Overleaf`}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="overleaf-toolbar-menu-item" onSelect={props.onOverleafOpen}>
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
              {props.overleafUnreadChat ? <em className="collab-peer-badge">{props.overleafUnreadChat}</em> : null}
            </button>
          </Tip>
        )}
        {props.overleafPresence}
        {props.onPaperLookup && <Tip label={t`Paper lookup`}>
          <button className="history-button" aria-label={t`Paper lookup`} onClick={props.onPaperLookup}>
            <BookOpen size={15} />
          </button>
        </Tip>}
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

const FORWARDED_HANDLERS = {
  setMode: true, onSplit: true, onCloseSplit: true, onPaperView: true, onInsert: true, onCollab: true,
  onHistory: true, onGit: true, onComments: true, onOverleafSync: true, onOverleafOpenCurrent: true,
  onOverleafOpen: true, onOverleafChat: true,
} as const satisfies Partial<Record<keyof CanvasToolbarProps, true>>;
type ForwardedHandlers = Pick<CanvasToolbarProps, keyof typeof FORWARDED_HANDLERS>;
const HANDLER_NAMES = Object.keys(FORWARDED_HANDLERS) as (keyof ForwardedHandlers)[];

/**
 * App rebuilds these handlers inline on every render, i.e. every keystroke.
 * Here they keep one identity for the component's life and forward to the
 * newest props through a ref, so the view memoizes on what it actually draws.
 * Optional handlers stay optional: the view reads their presence to decide what
 * to render.
 */
export function CanvasToolbar(props: CanvasToolbarProps) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const stable = useMemo(() => Object.fromEntries(HANDLER_NAMES.map((name) => [
    name,
    (...args: unknown[]) => (latest.current[name] as ((...args: unknown[]) => void) | undefined)?.(...args),
  ])) as Required<ForwardedHandlers>, []);
  const forwarded = Object.fromEntries(HANDLER_NAMES.map((name) => [name, props[name] ? stable[name] : undefined])) as ForwardedHandlers;
  return <CanvasToolbarView {...props} {...forwarded} />;
}
