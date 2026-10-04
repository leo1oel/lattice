import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { AgentGitWorkspaceView } from "../agent/synara-runtime";
import type { TrellisController, TrellisToolKind } from "../trellis/trellis-controller";
import type { AgentTurnReview } from "./app-synara-embed";
import type { EditorComments } from "./use-editor-comments";
import type { ReferenceImport } from "./use-reference-import";
import type { SynaraHost } from "./use-synara-host";
import { useLoadingShell } from "./use-loading-shell";

/** The tool drawers whose open state App itself keeps; comments and literature keep theirs in their own hooks. */
export type AppToolDrawer = "history" | "git" | "todos" | "checklist";

export type OpenToolOptions = {
  /** Git: show this view of the working tree. */
  gitView?: AgentGitWorkspaceView;
  /** Git: pin the drawer to one agent turn's checkpoint diff. */
  turnReview?: AgentTurnReview;
  /** Comments: open with this comment's reply box focused. */
  replyTo?: string;
};

const CLOSED: Record<AppToolDrawer, boolean> = { history: false, git: false, todos: false, checklist: false };

/**
 * The one way App opens a tool drawer, from wherever it is asked for: the
 * toolbar, the command palette, the editor, the agent, or a Trellis tool
 * panel that wants its content.
 *
 * Opening a tool first runs what keeps it current (TODOs re-scanned, the word
 * count re-read, the agent runtime started for Git). Then, because under
 * Trellis an open drawer is a panel, asking for it again brings that panel
 * forward (un-hidden, its tab selected, zoomed to) instead of doing nothing; a
 * drawer that is only now opening reveals itself as it docks.
 *
 * History and comments load lazily, so opening one is a transition: its
 * first open suspends an always-mounted boundary, and an urgent update would
 * commit the boundary's empty fallback, after which React holds the drawer
 * back until 300 ms after that commit (its Suspense reveal throttle), however
 * fast the chunk arrived. As a transition, React keeps the current screen
 * until the chunk is in; `loading` names the drawer once that has taken long
 * enough for its loading shell (`tool-loading-shell.tsx`), and the drawer is
 * still asked for.
 */
export function useToolDrawers({ trellis, synara, comments, references, commentsKind, commentsOpen, refreshTodos, refreshWordCount }: {
  trellis: TrellisController;
  synara: Pick<SynaraHost, "requestRuntime" | "origin" | "sourceControlFrameRef">;
  comments: Pick<EditorComments, "openPanel" | "openReply" | "closePanel">;
  /** Which tool panel the comments surface is: Overleaf's when the project is linked. */
  commentsKind: "comments" | "overleaf";
  /** Whether the comments surface, either kind, is open. */
  commentsOpen: boolean;
  references: Pick<ReferenceImport, "setLiteratureOpen">;
  refreshTodos: () => Promise<void>;
  refreshWordCount: () => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(CLOSED);
  const [gitView, setGitView] = useState<AgentGitWorkspaceView>("changes");
  /**
   * Non-null while the Git drawer is pinned to one agent turn's checkpoint
   * diff. Kept separate from gitView: the review needs a thread + turn to mean
   * anything, so its tab only exists while a request is present, and switching
   * to Changes / Pull requests drops back to the working tree.
   */
  const [turnReview, setTurnReview] = useState<AgentTurnReview | null>(null);
  const { requestRuntime, origin: synaraOrigin, sourceControlFrameRef } = synara;
  const { openPanel: openCommentsPanel, openReply, closePanel: closeCommentsPanel } = comments;
  const { setLiteratureOpen } = references;

  const setOpen = useCallback((kind: AppToolDrawer, open: boolean) => {
    setIsOpen((current) => (current[kind] === open ? current : { ...current, [kind]: open }));
  }, []);
  const [opening, startOpening] = useTransition();
  /** The lazy drawer last asked for, until it is closed: while it loads, only its shell can close it. */
  const [lazyPanel, setLazyPanel] = useState<"history" | "comments" | null>(null);
  const lazyPanelOpen = lazyPanel === "history" ? isOpen.history : commentsOpen;
  const loading = useLoadingShell(opening, lazyPanel !== null && (opening || lazyPanelOpen)) ? lazyPanel : null;
  const close = useCallback((kind: AppToolDrawer | "comments") => {
    setLazyPanel((current) => (current === kind ? null : current));
    if (kind === "comments") closeCommentsPanel();
    else setOpen(kind, false);
  }, [closeCommentsPanel, setOpen]);

  const open = useCallback((kind: TrellisToolKind, options: OpenToolOptions = {}) => {
    const reveal = () => {
      let panel = kind;
      if (kind === "comments" || kind === "overleaf") {
        panel = commentsKind;
        if (options.replyTo) openReply(options.replyTo);
        else openCommentsPanel();
      } else if (kind === "literature") {
        setLiteratureOpen(true);
      } else {
        if (kind === "git") {
          requestRuntime();
          if (options.turnReview) setTurnReview(options.turnReview);
          if (options.gitView) setGitView(options.gitView);
        } else if (kind === "todos") {
          void refreshTodos();
        } else if (kind === "checklist") {
          void refreshTodos();
          void refreshWordCount();
        }
        setOpen(kind, true);
      }
      trellis.revealOpenTool(panel);
    };
    if (kind !== "history" && kind !== "comments") {
      reveal();
      return;
    }
    setLazyPanel(kind);
    startOpening(reveal);
  }, [commentsKind, openCommentsPanel, openReply, refreshTodos, refreshWordCount, requestRuntime, setLiteratureOpen, setOpen, trellis]);

  /** Switch the Git drawer to a working-tree view, unpinning any turn review. */
  const showGitView = useCallback((view: AgentGitWorkspaceView) => {
    setTurnReview(null);
    setGitView(view);
  }, []);

  /** A pinned turn review belongs to the outgoing project's thread, and its TODOs to its files. */
  const resetForProject = useCallback(() => {
    setTurnReview(null);
    close("todos");
  }, [close]);

  // The source control embed has its own close button, which posts here.
  const gitOpen = isOpen.git;
  useEffect(() => {
    if (!synaraOrigin || !gitOpen) return;
    const closeSourceControl = (event: MessageEvent) => {
      if (
        event.source !== sourceControlFrameRef.current?.contentWindow ||
        event.origin !== synaraOrigin ||
        event.data?.type !== "lattice:close-source-control"
      ) {
        return;
      }
      close("git");
    };
    window.addEventListener("message", closeSourceControl);
    return () => window.removeEventListener("message", closeSourceControl);
  }, [close, gitOpen, synaraOrigin, sourceControlFrameRef]);

  return useMemo(() => ({
    isOpen, open, close, loading, gitView, turnReview, showGitView, resetForProject,
  }), [close, gitView, isOpen, loading, open, resetForProject, showGitView, turnReview]);
}

export type ToolDrawers = ReturnType<typeof useToolDrawers>;
