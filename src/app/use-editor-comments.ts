import { useLingui } from "@lingui/react/macro";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import { createEditorCommentReply, type EditorComment } from "../editor/comments/editor-comment-data";
import { useLatest } from "./effect-helpers";
import { setError } from "./notify";
import { OVERLEAF_COMMENT_PREFIX, type useOverleafWorkspace } from "./use-overleaf-workspace";

type Ref<T> = { readonly current: T };

/** An Overleaf thread's id, when this comment is one of theirs. */
export function overleafThreadOf(commentId: string): string | null {
  return commentId.startsWith(OVERLEAF_COMMENT_PREFIX) ? commentId.slice(OVERLEAF_COMMENT_PREFIX.length) : null;
}

/**
 * Comments anchored in the editor. This project's own live in
 * `.research/editor-comments.json`; a document edited live with Overleaf uses
 * Overleaf's comment threads instead, so collaborators in the browser see
 * them. Both kinds show together.
 */
export function useEditorComments({
  project, projectRootRef, overleaf, author, openSources, agentOptionsRef,
}: {
  project: ProjectSnapshot | null;
  projectRootRef: Ref<string | null>;
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  author: { id: string; name: string };
  /** The open buffers, which the agent's comment tools anchor against. */
  openSources: () => Map<string, string>;
  agentOptionsRef: { current: (() => BuildAgentCommentsOptions | null) | null };
}) {
  const { t } = useLingui();
  const [comments, setComments] = useState<EditorComment[]>([]);
  /** Read when the agent asks, where the state captured at render time may already be stale. */
  const commentsRef = useLatest(comments);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelFocus, setPanelFocus] = useState<{ id: string; projectRoot: string; nonce: string } | null>(null);
  const panelFocusId = panelFocus && panelFocus.projectRoot === project?.root ? panelFocus.id : null;
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: string } | null>(null);
  const openGenerationRef = useRef(0);
  const {
    overleafLink, overleafComments, overleafCommentsRef, overleafDocPaths, overleafRealtime, overleafEditorComments,
    setOverleafCollabOpen, setOverleafCollabTab,
  } = overleaf;

  const persist = useCallback(async (next: EditorComment[]) => {
    setComments(next);
    try {
      await invoke("save_editor_comments", { comments: next });
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  /**
   * Delete a comment, its replies with it, and hand back what puts it back
   * where it was. The undo reads the list as it is then, so anything changed
   * in between survives, and it does nothing once another project is open.
   */
  const remove = useCallback((id: string): (() => void) | null => {
    const before = commentsRef.current;
    const index = before.findIndex((comment) => comment.id === id);
    if (index < 0) return null;
    const removed = before[index];
    const root = projectRootRef.current;
    void persist(before.filter((comment) => comment.id !== id));
    return () => {
      const current = commentsRef.current;
      if (projectRootRef.current !== root || current.some((comment) => comment.id === id)) return;
      void persist([...current.slice(0, index), removed, ...current.slice(index)]);
    };
  }, [commentsRef, persist, projectRootRef]);

  const update = useCallback((id: string, change: (comment: EditorComment) => Partial<EditorComment>) => {
    void persist(comments.map((item) => (
      item.id === id ? { ...item, ...change(item), updatedAt: new Date().toISOString() } : item
    )));
  }, [comments, persist]);

  const toggleResolved = useCallback((id: string) => {
    const threadId = overleafThreadOf(id);
    if (!threadId) {
      update(id, (item) => ({ resolved: !item.resolved }));
      return;
    }
    const thread = overleafCommentsRef.current.threads.find((item) => item.id === threadId);
    void overleafCommentsRef.current.setResolved(threadId, !thread?.resolved).catch((reason) => setError(toMessage(reason)));
  }, [overleafCommentsRef, update]);

  const reply = useCallback((commentId: string, body: string) => {
    const threadId = overleafThreadOf(commentId);
    if (threadId) {
      void overleafCommentsRef.current.reply(threadId, body).catch((reason) => setError(toMessage(reason)));
      return;
    }
    // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
    const created = createEditorCommentReply({ body, authorId: author.id, authorName: author.name.trim() || "Anonymous" });
    if (created) update(commentId, (item) => ({ replies: [...item.replies, created] }));
  }, [author.id, author.name, overleafCommentsRef, update]);

  /** Add a comment the editor composed; see the module note for which kind it becomes. */
  const create = useCallback((comment: EditorComment) => {
    const docId = [...overleafDocPaths.entries()].find(([, path]) => path === comment.path)?.[0] ?? null;
    if (!overleafLink || !docId || !project) {
      void persist([...comments, comment]);
      setActiveId(comment.id);
      return;
    }
    if (!overleafRealtime.liveFile || overleafRealtime.docId !== docId) {
      setError(t`This file is not live with Overleaf right now. Reconnect before commenting.`);
      return;
    }
    void overleafComments
      .create({ projectRoot: project.root, docId, path: comment.path }, comment.from, comment.quote, comment.body)
      .catch((reason) => setError(toMessage(reason)));
  }, [comments, overleafComments, overleafDocPaths, overleafLink, overleafRealtime.docId, overleafRealtime.liveFile, persist, project, t]);

  const openPanel = useCallback(() => {
    setPanelFocus(null);
    setPanelOpen(!overleafLink);
    if (overleafLink) {
      setOverleafCollabTab("comments");
      setOverleafCollabOpen(true);
    }
  }, [overleafLink, setOverleafCollabOpen, setOverleafCollabTab]);
  const openReply = useCallback((commentId: string) => {
    openPanel();
    if (project) setPanelFocus({ id: commentId, projectRoot: project.root, nonce: crypto.randomUUID() });
  }, [openPanel, project]);
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setOverleafCollabOpen(false);
    setPanelFocus(null);
  }, [setOverleafCollabOpen]);

  /** Drop the outgoing project's comments; `load` reads the incoming one's. */
  const reset = useCallback(() => {
    setComments([]);
    setPanelOpen(false);
    setActiveId(null);
    setPanelFocus(null);
  }, []);
  const load = useCallback(async () => {
    setComments(await invoke<EditorComment[]>("list_editor_comments").catch(() => []));
  }, []);

  /** Both kinds of comment, as the editor and the panel want them. */
  const all = useMemo(() => [...comments, ...overleafEditorComments], [comments, overleafEditorComments]);

  useLayoutEffect(() => {
    agentOptionsRef.current = () => {
      if (!project || projectRootRef.current !== project.root) return null;
      return {
        workspaceRoot: project.root,
        localComments: commentsRef.current,
        overleafThreads: overleafComments.threads,
        overleafAnchors: [...overleafComments.anchors.values()],
        docPaths: overleafDocPaths,
        currentSources: openSources(),
        overleaf: { status: overleafLink ? "cached" : "not-linked" },
      };
    };
    return () => { agentOptionsRef.current = null; };
  }, [agentOptionsRef, commentsRef, openSources, overleafComments.anchors, overleafComments.threads, overleafDocPaths, overleafLink, project, projectRootRef]);

  return {
    comments, all, persist, remove, update, create, toggleResolved, reply, reset, load,
    panelOpen, openPanel, openReply, closePanel, panelFocus, panelFocusId, setPanelFocus,
    activeId, setActiveId, focusRequest, setFocusRequest, openGenerationRef,
  };
}

export type EditorComments = ReturnType<typeof useEditorComments>;
