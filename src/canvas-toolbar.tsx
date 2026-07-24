import {
  BookOpen,
  CloudUpload,
  FileCode2,
  GitBranch,
  History,
  Image,
  LoaderCircle,
  LocateFixed,
  MessageSquareText,
  Omega,
  Radio,
  Redo2,
  Undo2,
} from "lucide-react";
import { motion } from "motion/react";
import { Tip } from "./components/icon-tip";
import { type CanvasMode, type DocumentViewMode } from "./app-types";

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
  /** Present only when the project is linked to an Overleaf project. */
  overleafLinked?: boolean;
  overleafSyncing?: boolean;
  onOverleafSync?: () => void;
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
        {props.overleafLinked && props.onOverleafSync && (
          <Tip label={props.overleafSyncing ? "Syncing with Overleaf…" : "Sync with Overleaf"}>
            <button
              className="history-button"
              disabled={props.overleafSyncing}
              onClick={props.onOverleafSync}
            >
              {props.overleafSyncing ? <LoaderCircle className="spin" size={14} /> : <CloudUpload size={14} />}
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
