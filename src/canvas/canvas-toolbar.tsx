import { AppWindow, BookOpen, ChevronDown, Cloud, ExternalLink, FileCode2, Globe, Image, MessagesSquare } from "lucide-react";
import { memo, useMemo, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Tip } from "../components/icon-tip";
import { useLatestRef } from "../hooks/use-latest-ref";
import { AnimatedProductIcon } from "../animated-icons/product-animated-icon";
import { InfinityLoader } from "../components/ui/activity-icons";
import { StateSwap } from "../components/ui/motion";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { TitlebarTool } from "../settings/app-settings";

type CanvasToolbarProps = {
  activePath: string;
  activeKind: "document" | "paper" | "asset";
  dirty: boolean;
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
  /** Slot for the Overleaf presence avatars. */
  overleafPresence?: ReactNode;
  /** This page is a tab in the default browser rather than a Lattice window. */
  inBrowserTab?: boolean;
  /** Open in the browser, or (from a browser tab) back in the Lattice app. */
  onMoveWorkspace?: () => void;
  /** Tool buttons the writer hid in Settings → Appearance. */
  hiddenTools?: readonly TitlebarTool[];
};

/** A toolbar button named and described by its tooltip. */
function ToolbarButton({ label, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & { label: ReactNode }) {
  return <Tip label={label}><button type="button" {...button} /></Tip>;
}

const CanvasToolbarView = memo(function CanvasToolbarView(props: CanvasToolbarProps) {
  const { t } = useLingui();
  const ActiveIcon = props.activeKind === "asset" ? Image : props.activeKind === "paper" ? BookOpen : FileCode2;
  const shows = (tool: TitlebarTool) => !props.hiddenTools?.includes(tool);
  const showOverleafOnline = Boolean(props.overleafLinked)
    && Boolean(props.overleafSyncing || props.overleafLiveEditing || props.overleafChannel === "live");
  const overleafLabel = () => {
    if (!props.overleafLinked) return t`Open a project from Overleaf`;
    if (props.overleafSyncing) return t`Syncing with Overleaf…`;
    if (props.overleafPending) return t`New changes on Overleaf · click to pull`;
    if (props.overleafLiveEditing) return t`Live with Overleaf · click to sync`;
    // When this file is not live, say why: silently falling back to syncing
    // looks exactly like the feature being broken.
    const detail = props.overleafChannelDetail;
    switch (props.overleafChannel) {
      case "connecting": return detail || t`Connecting to Overleaf's live channel…`;
      case "error": return detail
        ? t({ message: `Live editing unavailable (${detail}) · syncing instead` })
        : t`Live editing unavailable · syncing instead`;
      case "live": return detail ? `${detail} · ${t`click to sync`}` : t`Live · click to sync`;
      default: return t`Sync with Overleaf`;
    }
  };
  return (
    <div className="canvas-toolbar">
      <div className="active-document"><ActiveIcon size={14} /><span>{props.activePath}</span>{props.activeKind === "document" && props.dirty && <i />}</div>
      <div className="canvas-actions" data-tour="workspace-actions">
        {props.activeKind === "document" && (
          <>
            {!props.overleafLinked && shows("comments") && (
              <ToolbarButton label={t`Editor comments`} className={props.commentCount ? "active" : ""} onClick={props.onComments}>
                <AnimatedProductIcon kind="chat" size={14} converted />
                {props.commentCount > 0 ? <em className="collab-peer-badge">{props.commentCount}</em> : null}
              </ToolbarButton>
            )}
          </>
        )}
        {shows("overleaf") && (props.onOverleafSync || props.onOverleafOpen) && (
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
                    ? <em className="collab-peer-badge overleaf-pending-badge">•</em>
                    : props.overleafLinked && (props.overleafChannel === "connecting" || props.overleafChannel === "error")
                      // The channel is on its way up or failed: say so at a glance,
                      // not only in the tooltip. Syncing carries on either way.
                      ? <em className="overleaf-channel-dot" data-state={props.overleafChannel} aria-hidden="true" />
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
        {shows("overleaf") && props.overleafLinked && props.onOverleafChat && (
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
        {shows("git") && (
          <ToolbarButton label={t`Git status and commit`} className="history-button" data-tour="git" onClick={props.onGit}>
            <AnimatedProductIcon kind="git-branch" size={15} />
          </ToolbarButton>
        )}
        {shows("history") && (
          <ToolbarButton label={t`Project history`} className="history-button" onClick={props.onHistory}>
            <AnimatedProductIcon kind="clock-back" size={15} />
          </ToolbarButton>
        )}
        {shows("browser") && props.onMoveWorkspace && (
          <ToolbarButton
            label={props.inBrowserTab ? t`Open in Lattice app` : t`Open in browser`}
            className="history-button"
            onClick={props.onMoveWorkspace}
          >
            {props.inBrowserTab ? <AppWindow size={15} /> : <Globe size={15} />}
          </ToolbarButton>
        )}
      </div>
    </div>
  );
});

const FORWARDED_HANDLERS = {
  onHistory: true, onGit: true, onComments: true, onOverleafSync: true, onOverleafOpenCurrent: true,
  onOverleafOpen: true, onOverleafChat: true, onMoveWorkspace: true,
} as const satisfies Partial<Record<keyof CanvasToolbarProps, true>>;
type ForwardedHandlers = Pick<CanvasToolbarProps, keyof typeof FORWARDED_HANDLERS>;
const HANDLER_NAMES = Object.keys(FORWARDED_HANDLERS) as (keyof ForwardedHandlers)[];

/**
 * App rebuilds these handlers inline on every keystroke. Here they keep one
 * identity and forward to the newest props, so the view memoizes on what it
 * draws. Optional handlers stay optional: their presence decides what renders.
 */
export function CanvasToolbar(props: CanvasToolbarProps) {
  const latest = useLatestRef(props);
  const stable = useMemo(() => Object.fromEntries(HANDLER_NAMES.map((name) => [
    name,
    (...args: unknown[]) => (latest.current[name] as ((...args: unknown[]) => void) | undefined)?.(...args),
  ])) as Required<ForwardedHandlers>, [latest]);
  const forwarded = Object.fromEntries(HANDLER_NAMES.map((name) => [name, props[name] ? stable[name] : undefined])) as ForwardedHandlers;
  return <CanvasToolbarView {...props} {...forwarded} />;
}
