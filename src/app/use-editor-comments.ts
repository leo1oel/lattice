import { useLingui } from "@lingui/react/macro";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenProjectFile, ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import {
  createEditorCommentReply,
  nextAnnotationNumber,
  type AnnotationRound,
  type EditorComment,
} from "../editor/comments/editor-comment-data";
import { showError } from "./notify";
import { notifyInfo } from "../telemetry/app-notify";
import { OVERLEAF_COMMENT_PREFIX, type useOverleafWorkspace } from "./use-overleaf-workspace";

type Ref<T> = { readonly current: T };

/** The project's local annotations and the revision rounds that asked about them. */
export type AnnotationsState = { annotations: EditorComment[]; rounds: AnnotationRound[] };

const EMPTY: AnnotationsState = { annotations: [], rounds: [] };

/** A change to the annotations alone, as `commit` takes one. */
function withAnnotations(change: (annotations: EditorComment[]) => EditorComment[]) {
  return (current: AnnotationsState): AnnotationsState => {
    const annotations = change(current.annotations);
    return annotations === current.annotations ? current : { ...current, annotations };
  };
}

/** How many annotation saves this session has sent, which orders them (`save_annotations`). */
const annotationSaves = { sent: 0 };

/** An Overleaf thread's id, when this comment is one of theirs. */
export function overleafThreadOf(commentId: string): string | null {
  return commentId.startsWith(OVERLEAF_COMMENT_PREFIX) ? commentId.slice(OVERLEAF_COMMENT_PREFIX.length) : null;
}

/**
 * Notes anchored in the editor. This project's own are annotations, kept in
 * `.research/annotations.json` with the revision rounds that asked the agent
 * about them (see `annotation-rounds.ts`); a document edited live with
 * Overleaf uses Overleaf's comment threads instead, so collaborators in the
 * browser see them. Both kinds show together.
 */
export function useEditorComments({
  project, projectRootRef, activeFileRef, openProjectFile, overleaf, author, openSources, agentOptionsRef,
}: {
  project: ProjectSnapshot | null;
  projectRootRef: Ref<string | null>;
  activeFileRef: Ref<string>;
  openProjectFile: OpenProjectFile;
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  author: { id: string; name: string };
  /** The open buffers, which the agent's comment tools anchor against. */
  openSources: () => Map<string, string>;
  agentOptionsRef: { current: (() => BuildAgentCommentsOptions | null) | null };
}) {
  const { t } = useLingui();
  const [state, setState] = useState<AnnotationsState>(EMPTY);
  /**
   * The state as of the last change, ahead of React's render: a round's
   * answers land one after another, and each must build on the one before.
   */
  const stateRef = useRef<AnnotationsState>(EMPTY);
  const loadGenerationRef = useRef(0);
  const comments = state.annotations;
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

  /**
   * Change the annotations and rounds, and save them. Each save names the
   * project it belongs to, which the backend refuses once another is open,
   * and its place in this session's order, so a save that finishes after a
   * newer one is dropped there rather than writing older state over it.
   */
  const commit = useCallback((change: (current: AnnotationsState) => AnnotationsState) => {
    const projectRoot = projectRootRef.current;
    const current = stateRef.current;
    const next = change(current);
    if (!projectRoot || next === current) return;
    stateRef.current = next;
    setState(next);
    annotationSaves.sent += 1;
    const save = annotationSaves.sent;
    void invoke<void>("save_annotations", { projectRoot, annotations: next.annotations, rounds: next.rounds, save })
      .catch((reason: unknown) => showError(toMessage(reason)));
  }, [projectRootRef]);


  /**
   * Delete a comment and its replies at once, with an Undo toast rather than a
   * confirmation: the comment is local and can be put back where it was. The
   * undo reads the list as it is then, so anything changed in between
   * survives, and it does nothing once another project is open.
   */
  const deleteComment = useCallback((id: string) => {
    const before = stateRef.current.annotations;
    const index = before.findIndex((comment) => comment.id === id);
    if (index < 0) return;
    const removed = before[index];
    const root = projectRootRef.current;
    commit(withAnnotations((current) => current.filter((comment) => comment.id !== id)));
    setActiveId((current) => (current === id ? null : current));
    notifyInfo(t`Annotations`, t`Annotation deleted`, {
      dedupeKey: `editor-comment-deleted:${id}`,
      primaryAction: {
        label: t`Undo`,
        onClick: () => {
          if (projectRootRef.current !== root) return;
          commit(withAnnotations((current) => current.some((comment) => comment.id === id)
            ? current
            : [...current.slice(0, index), removed, ...current.slice(index)]));
        },
      },
    });
  }, [commit, projectRootRef, t]);

  const update = useCallback((id: string, change: (comment: EditorComment) => Partial<EditorComment>) => {
    commit(withAnnotations((current) => current.map((item) => (
      item.id === id ? { ...item, ...change(item), updatedAt: new Date().toISOString() } : item
    ))));
  }, [commit]);

  const setResolved = useCallback((id: string, resolved: boolean) => {
    const threadId = overleafThreadOf(id);
    if (!threadId) {
      update(id, () => ({ resolved }));
      return;
    }
    void overleafCommentsRef.current.setResolved(threadId, resolved).catch((reason) => showError(toMessage(reason)));
  }, [overleafCommentsRef, update]);

  const toggleResolved = useCallback((id: string) => {
    const threadId = overleafThreadOf(id);
    const resolved = threadId
      ? overleafCommentsRef.current.threads.find((item) => item.id === threadId)?.resolved
      : stateRef.current.annotations.find((item) => item.id === id)?.resolved;
    setResolved(id, !resolved);
  }, [overleafCommentsRef, setResolved]);

  /**
   * Resolve from a comment's card on the document, which leaves with it: the
   * toast says it happened and offers it back, in the project it happened in.
   */
  const resolve = useCallback((id: string) => {
    const root = projectRootRef.current;
    setResolved(id, true);
    notifyInfo(t`Comments`, t`Comment resolved`, {
      dedupeKey: `editor-comment-resolved:${id}`,
      primaryAction: {
        label: t`Undo`,
        onClick: () => {
          if (projectRootRef.current === root) setResolved(id, false);
        },
      },
    });
  }, [projectRootRef, setResolved, t]);

  const reply = useCallback((commentId: string, body: string) => {
    const threadId = overleafThreadOf(commentId);
    if (threadId) {
      void overleafCommentsRef.current.reply(threadId, body).catch((reason) => showError(toMessage(reason)));
      return;
    }
    // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
    const created = createEditorCommentReply({ body, authorId: author.id, authorName: author.name.trim() || "Anonymous" });
    if (created) update(commentId, (item) => ({ replies: [...item.replies, created] }));
  }, [author.id, author.name, overleafCommentsRef, update]);

  /**
   * Add a note the editor or the PDF composed; see the module note for which
   * kind it becomes. A local annotation takes the next pin number. Resolves
   * to the annotation as saved, or null when it became an Overleaf thread or
   * could not be made.
   */
  const create = useCallback((comment: EditorComment): EditorComment | null => {
    const docId = [...overleafDocPaths.entries()].find(([, path]) => path === comment.path)?.[0] ?? null;
    if (!overleafLink || !docId || !project) {
      const annotation = { ...comment, number: nextAnnotationNumber(stateRef.current.annotations) };
      commit(withAnnotations((current) => [...current, annotation]));
      setActiveId(annotation.id);
      return annotation;
    }
    if (!overleafRealtime.liveFile || overleafRealtime.docId !== docId) {
      showError(t`This file is not live with Overleaf right now. Reconnect before commenting.`);
      return null;
    }
    void overleafComments
      .create({ projectRoot: project.root, docId, path: comment.path }, comment.from, comment.quote, comment.body)
      .catch((reason) => showError(toMessage(reason)));
    return null;
  }, [overleafComments, overleafDocPaths, overleafLink, overleafRealtime.docId, overleafRealtime.liveFile, project, commit, t]);

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

  /**
   * Open the comment's file and ask the editor to focus the comment, unless
   * another comment was opened or the file changed meanwhile. The Annotations
   * panel stays beside the editor; Overleaf's drawer, which stands in the
   * document's place, closes.
   */
  const openComment = useCallback((comment: EditorComment) => {
    const generation = ++openGenerationRef.current;
    setActiveId(comment.id);
    if (overleafLink) closePanel();
    // The focus below places the editor; a remembered position must not land after it.
    void openProjectFile(comment.path, { restoreView: false }).then(() => {
      if (openGenerationRef.current !== generation || activeFileRef.current !== comment.path) return;
      setFocusRequest({ id: comment.id, nonce: crypto.randomUUID() });
    });
  }, [activeFileRef, closePanel, openProjectFile, overleafLink]);
  /** The editor focused the comment `nonce` asked for. */
  const focusHandled = useCallback((nonce: string) => {
    setFocusRequest((current) => (current?.nonce === nonce ? null : current));
  }, []);

  /** Drop the outgoing project's annotations; `load` reads the incoming one's. */
  const reset = useCallback(() => {
    loadGenerationRef.current += 1;
    stateRef.current = EMPTY;
    setState(EMPTY);
    setPanelOpen(false);
    setActiveId(null);
    setPanelFocus(null);
  }, []);
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const loaded = await invoke<AnnotationsState>("list_annotations").catch(() => EMPTY);
    if (loadGenerationRef.current !== generation) return;
    const next = { annotations: loaded?.annotations ?? [], rounds: loaded?.rounds ?? [] };
    stateRef.current = next;
    setState(next);
  }, []);

  /** Both kinds of comment, as the editor and the panel want them. */
  const all = useMemo(() => [...comments, ...overleafEditorComments], [comments, overleafEditorComments]);

  useLayoutEffect(() => {
    agentOptionsRef.current = () => {
      if (!project || projectRootRef.current !== project.root) return null;
      return {
        workspaceRoot: project.root,
        localComments: stateRef.current.annotations,
        overleafThreads: overleafComments.threads,
        overleafAnchors: [...overleafComments.anchors.values()],
        docPaths: overleafDocPaths,
        currentSources: openSources(),
        overleaf: { status: overleafLink ? "cached" : "not-linked" },
      };
    };
    return () => { agentOptionsRef.current = null; };
  }, [agentOptionsRef, openSources, overleafComments.anchors, overleafComments.threads, overleafDocPaths, overleafLink, project, projectRootRef]);

  return {
    comments, rounds: state.rounds, stateRef, commit, all, update, create, toggleResolved, resolve, reply, reset, load, openComment,
    deleteComment, panelOpen, openPanel, openReply, closePanel, panelFocus, panelFocusId, setPanelFocus,
    activeId, setActiveId, focusRequest, focusHandled,
  };
}

export type EditorComments = ReturnType<typeof useEditorComments>;
