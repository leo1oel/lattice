import {
  BookOpen,
  Cloud,
  CloudUpload,
  FileCode2,
  GitBranch,
  History,
  Image,
  LoaderCircle,
  LocateFixed,
  MessageSquareText,
  MessagesSquare,
  Omega,
  Radio,
  Redo2,
  Undo2,
} from "lucide-react";
import { motion } from "motion/react";
import { Tip } from "./components/icon-tip";
import { type CanvasMode, type DocumentViewMode } from "./app-types";

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
) {
  if (channel === "connecting") return "Connecting to Overleaf's live channel…";
  if (channel === "error") {
    return `Live editing unavailable${detail ? ` (${detail})` : ""} · syncing instead`;
  }
  if (channel === "live") {
    return detail ? `${detail} · click to sync` : "Connected live · click to sync everything";
  }
  return "Sync with Overleaf";
}

export function CanvasToolbar(props: {
  mode: CanvasMode;
  setMode: (mode: DocumentViewMode) => void;
  activePath: string;
  activeKind: "document" | "paper" | "asset";
  dirty: boolean;
  canForwardSync: boolean;
  locatingPdf: boolean;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onInsert: () => void;
  onCollab: () => void;
  collabLive: boolean;
  collabPeers: number;
  onForwardSync: () => void;
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
  onOverleafOpen?: () => void;
  /** Open comments plus unread chat: what is waiting on you in the project. */
  overleafUnreadChat?: number;
  onOverleafChat?: () => void;
}) {
  const ActiveIcon = props.activeKind === "asset" ? Image : props.activeKind === "paper" ? BookOpen : FileCode2;
  const switcherMode = props.mode === "dual" || props.mode === "columns" ? "split" : props.mode;
  return (
    <div className="canvas-toolbar">
      <div className="active-document"><ActiveIcon size={14} /><span>{props.activePath}</span>{props.activeKind === "document" && props.dirty && <i />}</div>
      <div className="view-switcher">
        {([
          { id: "source" as const, label: "source", title: "Source only" },
          { id: "split" as const, label: "split", title: "Source and PDF" },
          { id: "pdf" as const, label: "pdf", title: "PDF only" },
        ]).map((mode) => {
          const active = switcherMode === mode.id;
          return (
            <button
              key={mode.id}
              className={active ? "active" : ""}
              title={mode.title}
              onClick={() => props.setMode(mode.id)}
            >
              {active && (
                <motion.span
                  layoutId="view-switcher-pill"
                  className="view-switcher-pill"
                  transition={{ type: "tween", ease: [0.65, 0, 0.35, 1], duration: 0.25 }}
                />
              )}
              <span className="view-switcher-label">{mode.label}</span>
            </button>
          );
        })}
      </div>
      <div className="canvas-actions">
        {props.activeKind === "document" && (
          <>
            <Tip label="Go back (⌘[)">
              <button type="button" disabled={!props.canNavigateBack} onClick={props.onNavigateBack}>
                <Undo2 size={14} />
              </button>
            </Tip>
            <Tip label="Go forward (⌘])">
              <button type="button" disabled={!props.canNavigateForward} onClick={props.onNavigateForward}>
                <Redo2 size={14} />
              </button>
            </Tip>
            <Tip label="Insert snippet or symbol (⌘⇧I)">
              <button type="button" onClick={props.onInsert}>
                <Omega size={14} />
              </button>
            </Tip>
            <Tip label="Editor comments">
              <button
                type="button"
                className={props.commentCount ? "active" : ""}
                onClick={props.onComments}
              >
                <MessageSquareText size={14} />
                {props.commentCount > 0 ? <em className="collab-peer-badge">{props.commentCount}</em> : null}
              </button>
            </Tip>
            <Tip label={props.collabLive
              ? (props.collabPeers > 0
                ? `Live · ${props.collabPeers} other${props.collabPeers === 1 ? "" : "s"}`
                : "Live collaboration · just you")
              : "Live collaboration"}
            >
              <button
                type="button"
                className={props.collabLive ? "active collab-toolbar-button" : "collab-toolbar-button"}
                onClick={props.onCollab}
              >
                <Radio size={14} />
                {props.collabLive ? <em className="collab-peer-badge">{props.collabPeers}</em> : null}
              </button>
            </Tip>
            <Tip label="Reveal cursor in PDF (⌘⇧J)">
              <button disabled={!props.canForwardSync || props.locatingPdf} onClick={props.onForwardSync}>
                {props.locatingPdf ? <LoaderCircle className="spin" size={14} /> : <LocateFixed size={14} />}
              </button>
            </Tip>
          </>
        )}
        {(props.onOverleafSync || props.onOverleafOpen) && (
          <Tip label={props.overleafLinked
            ? (props.overleafSyncing
              ? "Syncing with Overleaf…"
              : props.overleafPending
                ? "New changes on Overleaf — click to bring them in"
                : props.overleafLiveEditing
                  ? "Editing live with Overleaf · click to sync everything else"
                  : overleafChannelLabel(props.overleafChannel, props.overleafChannelDetail))
            : "Open a project from Overleaf"}
          >
            <button
              className={props.overleafLinked ? "history-button active" : "history-button"}
              disabled={props.overleafSyncing}
              onClick={props.overleafLinked ? props.onOverleafSync : props.onOverleafOpen}
            >
              {props.overleafSyncing
                ? <LoaderCircle className="spin" size={14} />
                : props.overleafLinked ? <CloudUpload size={14} /> : <Cloud size={14} />}
              {props.overleafLiveEditing && !props.overleafSyncing
                ? <em className="overleaf-live-dot" title="Editing live with Overleaf" />
                : props.overleafPending && !props.overleafSyncing
                  ? <em className="collab-peer-badge">•</em>
                  : null}
            </button>
          </Tip>
        )}
        {props.overleafLinked && props.onOverleafChat && (
          <Tip label={props.overleafUnreadChat
            ? `Overleaf comments and chat · ${props.overleafUnreadChat} waiting`
            : "Overleaf comments and chat"}
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
        <Tip label="Git status and commit">
          <button className="history-button" onClick={props.onGit}>
            <GitBranch size={14} />
          </button>
        </Tip>
        <Tip label="Project history">
          <button className="history-button" onClick={props.onHistory}>
            <History size={14} />
          </button>
        </Tip>
      </div>
    </div>
  );
}
