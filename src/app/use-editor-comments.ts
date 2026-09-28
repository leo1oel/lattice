import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import {
  collabCommentsMap,
  readCollabComments,
  seedCollabCommentsFromContent,
  writeCollabComments,
} from "../collab/collab-comments";
import type { CollabProjectControllerV2 } from "../collab/collab-project-v2";
import { isClientDestroyedErrorV2 } from "../collab/collab-text-v2";
import {
  createEditorCommentReply,
  EDITOR_COMMENTS_PATH,
  mergeEditorComments,
  type EditorComment,
} from "../editor/comments/editor-comment-data";
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
 * `.research/editor-comments.json` (and in a share, on a shared map beside
 * it); a document edited live with Overleaf uses Overleaf's comment threads
 * instead, so collaborators in the browser see them. Both kinds show together.
 */
export function useEditorComments({
  project, projectRootRef, shared, overleaf, author, openSources, agentOptionsRef,
}: {
  project: ProjectSnapshot | null;
  projectRootRef: Ref<string | null>;
  /** The live share's controller when a v2 share is active; `fileCount` re-checks for the comments file. */
  shared: { controllerRef: Ref<CollabProjectControllerV2 | null>; active: boolean; fileCount: number };
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  author: { id: string; name: string };
  /** The open buffers, which the agent's comment tools anchor against. */
  openSources: () => Map<string, string>;
  agentOptionsRef: { current: (() => BuildAgentCommentsOptions | null) | null };
}) {
  const [comments, setComments] = useState<EditorComment[]>([]);
  /** Read inside async publishes, where the state captured at call time is already stale. */
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
  const { controllerRef, active: sharedActive, fileCount } = shared;

  const persist = useCallback(async (next: EditorComment[]) => {
    // What this client held before the edit is what makes a delete expressible
    // in the shared map: only a comment we actually had may be removed there.
    const previous = commentsRef.current;
    setComments(next);
    try {
      await invoke("save_editor_comments", { comments: next });
      const controller = controllerRef.current;
      if (!sharedActive || !controller) return;
      // The controller owns this document — it registers the file on first use
      // and pins it, so both sides keep writing to the same one.
      const doc = await controller.openCommentsDoc();
      if (!doc) return;
      seedCollabCommentsFromContent(doc);
      writeCollabComments(doc, next, previous);
      // The map now holds our edit merged with whatever peers wrote while we
      // were composing it, so adopt that union rather than our own view.
      const merged = readCollabComments(doc);
      setComments(merged);
      await invoke("save_editor_comments", { comments: merged });
    } catch (reason) {
      // The comments document is opened unpinned, so the provider pool is free
      // to evict (destroy) it between publishes. Reaching a destroyed client is
      // a teardown, not a failed save — the comment is already on disk — and
      // the next publish reopens it.
      if (!isClientDestroyedErrorV2(reason)) setError(toMessage(reason));
    }
  }, [commentsRef, controllerRef, sharedActive]);

  /**
   * Live-update the comments panel from the shared comments file. Peer
   * publishes land in the file's Yjs doc and mirror to disk, but without this
   * observer the panel's state only refreshed on project reload. Local-origin
   * transactions (our own publishes) are skipped — state is already set.
   * `fileCount` re-runs the check so a comments file created mid-share gets
   * observed once it appears in the catalog.
   */
  useEffect(() => {
    const controller = controllerRef.current;
    if (!sharedActive || !controller?.hasTextPath(EDITOR_COMMENTS_PATH)) return;
    let cancelled = false;
    let detach: (() => void) | undefined;
    void controller.openCommentsDoc().then((doc) => {
      if (cancelled || !doc) return;
      seedCollabCommentsFromContent(doc);
      const map = collabCommentsMap(doc);
      // Read what is already in the map, not just what changes next: the file
      // only enters the catalog when the first comment is written, so a peer
      // cannot attach until after that comment exists — and an observer never
      // reports it. Merge rather than replace, since local comments may not
      // have reached the map yet.
      const apply = () => setComments((current) => mergeEditorComments(readCollabComments(doc), current));
      apply();
      map.observe(apply);
      detach = () => map.unobserve(apply);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [controllerRef, fileCount, sharedActive]);

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
      setError("This file is not live with Overleaf right now. Reconnect before commenting.");
      return;
    }
    void overleafComments
      .create({ projectRoot: project.root, docId, path: comment.path }, comment.from, comment.quote, comment.body)
      .catch((reason) => setError(toMessage(reason)));
  }, [comments, overleafComments, overleafDocPaths, overleafLink, overleafRealtime.docId, overleafRealtime.liveFile, persist, project]);

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
    comments, all, persist, update, create, toggleResolved, reply, reset, load,
    panelOpen, openPanel, openReply, closePanel, panelFocus, panelFocusId, setPanelFocus,
    activeId, setActiveId, focusRequest, setFocusRequest, openGenerationRef,
  };
}

export type EditorComments = ReturnType<typeof useEditorComments>;
