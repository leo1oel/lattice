import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenProjectFile, ProjectSnapshot } from "../app-types";
import { hostErrorMessage, toMessage } from "../app-utils";
import { baseName } from "../lib/base-name";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import {
  createEditorCommentReply,
  nextAnnotationNumber,
  type AnnotationRound,
  type EditorComment,
  type NoteProgress,
} from "../editor/comments/editor-comment-data";
import { publishMarginReviewComments } from "../overleaf/margin-review-files";
import { showError } from "./notify";
import { notifyInfo } from "../telemetry/app-notify";
import { OVERLEAF_COMMENT_PREFIX } from "../overleaf/overleaf-editor-comments";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";

type Ref<T> = { readonly current: T };

/**
 * Where a note made on the PDF goes: an annotation of this project's, or a
 * thread on Overleaf. A thread is anchored through the live channel: in the
 * open file when the channel holds it ("overleaf"), or by joining the file's
 * document in the background ("other-file", `createInDocument`). While nothing
 * is live ("offline") it can go nowhere yet.
 */
export type CommentDestination = "annotation" | "overleaf" | "other-file" | "offline";

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

/** How long a comment waits for the sync owed its file to bring Overleaf's copy up to the passage. */
const SYNC_WAIT_MS = 15_000;

/** Resolves true once `owed` stops holding, false if it still holds after `SYNC_WAIT_MS`; nothing announces it. */
function syncSettled(owed: () => boolean) {
  const deadline = Date.now() + SYNC_WAIT_MS;
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (!owed()) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else window.setTimeout(check, 250);
    };
    check();
  });
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
  /**
   * Whether `state` holds what the project's file had: null until a load
   * lands (`reset` clears it for each project entered), else why the file
   * could not be read, if it could not. A save replaces the whole file, so a
   * state never read (an entry cut short, a file that would not parse) must
   * not be saved over what is on disk.
   */
  const loadedRef = useRef<{ error: string | null } | null>(null);
  // Citation reasons share the store but not the review: they take no pin,
  // draw no mark, and the agent never revises from them (citation-reasons.ts).
  const comments = useMemo(() => state.annotations.filter((item) => !item.citation), [state.annotations]);
  const citationReasons = useMemo(() => state.annotations.filter((item) => item.citation), [state.annotations]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelFocus, setPanelFocus] = useState<{ id: string; projectRoot: string; nonce: string } | null>(null);
  const panelFocusId = panelFocus && panelFocus.projectRoot === project?.root ? panelFocus.id : null;
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: string } | null>(null);
  /** How many open citation reasons the Annotations panel lists because their cite is gone (app-editor-panels.tsx). */
  const [openOrphans, setOpenOrphans] = useState(0);
  const openGenerationRef = useRef(0);
  const {
    overleafLink, overleafComments, overleafCommentsRef, overleafDocPaths, overleafRealtime, overleafEditorComments,
    overleafSyncOwed, setOverleafCollabOpen, setOverleafCollabTab,
  } = overleaf;

  /**
   * Change the annotations and rounds, and save them. Each save names the
   * project it belongs to, which the backend refuses once another is open,
   * and its place in this session's order, so a save that finishes after a
   * newer one is dropped there rather than writing older state over it.
   * Refused, saying why, until this project's annotations have been read.
   * Returns whether the change was made.
   */
  const commit = useCallback((change: (current: AnnotationsState) => AnnotationsState): boolean => {
    const projectRoot = projectRootRef.current;
    if (!projectRoot) return false;
    const loaded = loadedRef.current;
    if (loaded?.error !== null) {
      const error = loaded?.error ?? null;
      showError(error === null
        ? t`This project's annotations are still being read. Try again in a moment.`
        : t`This project's annotations could not be read, so changes to them are not saved: ${error}`);
      return false;
    }
    const current = stateRef.current;
    const next = change(current);
    if (next === current) return false;
    stateRef.current = next;
    setState(next);
    annotationSaves.sent += 1;
    const save = annotationSaves.sent;
    void invoke<void>("save_annotations", { projectRoot, annotations: next.annotations, rounds: next.rounds, save })
      .catch((reason: unknown) => showError(toMessage(reason)));
    return true;
  }, [projectRootRef, t]);


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

  /** Add a citation reason, or replace the one with its id; always a local annotation, never an Overleaf thread. */
  const saveCitationReason = useCallback((reason: EditorComment) => {
    commit(withAnnotations((current) => current.some((item) => item.id === reason.id)
      ? current.map((item) => (item.id === reason.id ? { ...reason, updatedAt: new Date().toISOString() } : item))
      : [...current, reason]));
  }, [commit]);

  /**
   * Store where citation reasons now sit, as the editor found them after an
   * edit; the reason itself did not change, so neither does its updatedAt.
   * An editor torn down after a project switch still flushes its last save
   * here, into a store that was reset or holds another project: that save is
   * dropped silently, before `commit` would toast "still being read".
   */
  const reanchorCitationReasons = useCallback((moves: ReadonlyMap<string, Pick<EditorComment, "from" | "to" | "quote" | "prefix" | "suffix">>) => {
    if (!stateRef.current.annotations.some((item) => moves.has(item.id))) return;
    commit(withAnnotations((current) => current.map((item) => {
      const move = moves.get(item.id);
      return move && item.citation ? { ...item, ...move } : item;
    })));
  }, [commit]);

  /**
   * The project's citation key `from` was renamed to `to`: its reasons
   * follow, letter case aside as citation keys match, and keep their anchors.
   */
  const renameCitationKey = useCallback((from: string, to: string) => {
    const renamed = (item: EditorComment) => item.citation?.key.toLocaleLowerCase() === from.toLocaleLowerCase();
    commit(withAnnotations((current) => (
      current.some(renamed)
        ? current.map((item) => (renamed(item) ? { ...item, citation: { ...item.citation!, key: to } } : item))
        : current
    )));
  }, [commit]);

  const setResolved = useCallback((id: string, resolved: boolean) => {
    const threadId = overleafThreadOf(id);
    if (!threadId) {
      update(id, () => ({ resolved }));
      return;
    }
    void overleafCommentsRef.current.setResolved(threadId, resolved).catch((reason) => showError(toMessage(reason)));
  }, [overleafCommentsRef, update]);

  /**
   * Resolve or reopen, saying so in a toast that offers it back, in the
   * project it happened in: a card on the document leaves as it resolves,
   * and the panel's card leaves its filter, so the toast is what remains.
   */
  const changeResolved = useCallback((id: string, resolved: boolean) => {
    const root = projectRootRef.current;
    setResolved(id, resolved);
    notifyInfo(t`Comments`, resolved ? t`Comment resolved` : t`Comment reopened`, {
      dedupeKey: `editor-comment-resolved:${id}`,
      primaryAction: {
        label: t`Undo`,
        onClick: () => {
          if (projectRootRef.current === root) setResolved(id, !resolved);
        },
      },
    });
  }, [projectRootRef, setResolved, t]);

  const toggleResolved = useCallback((id: string) => {
    const threadId = overleafThreadOf(id);
    const resolved = threadId
      ? overleafCommentsRef.current.threads.find((item) => item.id === threadId)?.resolved
      : stateRef.current.annotations.find((item) => item.id === id)?.resolved;
    changeResolved(id, !resolved);
  }, [changeResolved, overleafCommentsRef]);

  /** Resolve from a comment's card on the document, which leaves with it. */
  const resolve = useCallback((id: string) => changeResolved(id, true), [changeResolved]);

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

  const docIdOf = useCallback((path: string) => (
    [...overleafDocPaths.entries()].find(([, docPath]) => docPath === path)?.[0] ?? null
  ), [overleafDocPaths]);
  /**
   * Where a note on `path` made on the PDF goes. Unlike `create`, a linked
   * project whose channel has not named its documents yet is "offline", not
   * an annotation: a note meant for Overleaf must not be kept here unseen.
   */
  const destination = useCallback((path: string): CommentDestination => {
    if (!overleafLink || !project) return "annotation";
    const docId = docIdOf(path);
    if (!docId && overleafDocPaths.size) return "annotation";
    if (overleafRealtime.liveFile && overleafRealtime.docId === docId) return "overleaf";
    return overleafRealtime.status === "live" ? "other-file" : "offline";
  }, [docIdOf, overleafDocPaths, overleafLink, overleafRealtime.docId, overleafRealtime.liveFile, overleafRealtime.status, project]);

  /**
   * Add a note the editor or the PDF composed; see the module note for which
   * kind it becomes. A local annotation takes the next pin number. Returns the
   * annotation as saved, "overleaf" when it is being sent as an Overleaf
   * thread, whose progress `report` follows to the end (null once Overleaf
   * has it, else why not, so the composer keeps what was typed), or null
   * when it was refused (saying why).
   *
   * A document of the linked project takes the comment as an Overleaf thread
   * whether or not the editor holds it live. The editor lets go of its file
   * for a while in ordinary use: an outside write (the Agent revising it, say)
   * hands it to regular sync until a sync settles it, and a reconnect or a
   * co-author's text arriving takes it out of live editing for a moment.
   * Refusing the comment meanwhile told the writer to reconnect when nothing
   * needed it. Overleaf anchors a thread on any document a connection has
   * joined, so the backend joins it on a connection of its own, as for a note
   * made on the PDF, and places the passage through whatever separates its
   * copy from the open buffer, which the comment's offsets count into. A
   * passage the outside write brought is in Overleaf's copy only once that
   * sync has settled, so a comment on it waits for the sync and tries again.
   */
  const create = useCallback((comment: EditorComment, report: (progress: NoteProgress) => void): EditorComment | "overleaf" | null => {
    const docId = docIdOf(comment.path);
    if (!overleafLink || !docId || !project) {
      const annotation = { ...comment, number: nextAnnotationNumber(stateRef.current.annotations) };
      if (!commit(withAnnotations((current) => [...current, annotation]))) return null;
      setActiveId(annotation.id);
      return annotation;
    }
    const target = { projectRoot: project.root, docId, path: comment.path };
    const name = baseName(comment.path);
    const failed = (reason: unknown) => {
      const message = hostErrorMessage(reason);
      report({ saving: null, error: t`Your comment on ${name} did not reach Overleaf: ${message}` });
    };
    if (overleafRealtime.liveFile && overleafRealtime.docId === docId) {
      report({ saving: t`Commenting on ${name} on Overleaf…`, error: null });
      void overleafComments.create(target, comment.from, comment.quote, comment.body).then(() => report(null), failed);
      return "overleaf";
    }
    const source = openSources().get(comment.path);
    if (source === undefined) {
      showError(t`Open ${name} to comment on it.`);
      return null;
    }
    const place = () => overleafComments.createInDocument(target, source, comment.from, comment.quote, comment.body);
    const placeOnceSynced = async () => {
      const placement = await place();
      if (placement === "placed" || !overleafSyncOwed(comment.path)) return placement;
      report({ saving: t`Waiting for ${name} to finish syncing with Overleaf…`, error: null });
      return await syncSettled(() => overleafSyncOwed(comment.path)) ? place() : "unsynced";
    };
    report({ saving: t`Commenting on ${name} on Overleaf…`, error: null });
    void placeOnceSynced().then((placement) => {
      if (placement === "placed") report(null);
      else if (placement === "notFound") {
        report({ saving: null, error: t`Your comment on ${name} did not reach Overleaf: its copy reads differently around the selected text, which changed here since the last sync. Try again once the file has synced.` });
      } else {
        report({ saving: null, error: t`${name} is still syncing with Overleaf, so your comment is not on it yet. Try again once the sync finishes.` });
      }
    }, failed);
    return "overleaf";
  }, [docIdOf, openSources, overleafComments, overleafLink, overleafRealtime.docId, overleafRealtime.liveFile, overleafSyncOwed, project, commit, t]);

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
    loadedRef.current = null;
    stateRef.current = EMPTY;
    setState(EMPTY);
    setPanelOpen(false);
    setActiveId(null);
    setPanelFocus(null);
  }, []);
  /**
   * Read the project's annotations. A file that cannot be read (bad JSON, a
   * merge's conflict markers) says so and keeps them unsaved, rather than
   * reading as none and being replaced by the next one made.
   */
  const load = useCallback(async () => {
    // `reset` moves the generation on whenever another project is entered.
    const generation = ++loadGenerationRef.current;
    const loaded = await invoke<AnnotationsState>("list_annotations").then(
      (value) => ({ value, error: null }),
      (reason: unknown) => ({ value: null, error: toMessage(reason) }),
    );
    if (loadGenerationRef.current !== generation) return;
    const { error } = loaded;
    loadedRef.current = { error };
    if (error !== null) {
      showError(t`This project's annotations could not be read, so changes to them are not saved: ${error}`);
      return;
    }
    const next = { annotations: loaded.value?.annotations ?? [], rounds: loaded.value?.rounds ?? [] };
    stateRef.current = next;
    setState(next);
  }, [t]);

  /** Both kinds of comment, as the editor and the panel want them. */
  const all = useMemo(() => [...comments, ...overleafEditorComments], [comments, overleafEditorComments]);
  /** How many notes are still open, as the toolbar's comments button counts them: the panel's orphaned reasons too. */
  const unresolved = all.filter((comment) => !comment.resolved).length + openOrphans;

  // The files that open with Overleaf's threads beside their source, which
  // their skeleton is drawn for before they are read (margin-review-files.ts).
  const overleafProject = overleafLink?.projectId ?? "";
  useEffect(() => {
    publishMarginReviewComments(overleafProject, overleafEditorComments.flatMap((comment) => comment.resolved ? [] : [comment.path]));
  }, [overleafEditorComments, overleafProject]);

  useLayoutEffect(() => {
    agentOptionsRef.current = () => {
      if (!project || projectRootRef.current !== project.root) return null;
      return {
        workspaceRoot: project.root,
        localComments: stateRef.current.annotations.filter((item) => !item.citation),
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
    comments, citationReasons, saveCitationReason, reanchorCitationReasons, renameCitationKey, setOpenOrphans, rounds: state.rounds, stateRef, commit, all, unresolved, update, create, destination,
    // A thread on a file the live channel does not hold, which the backend
    // joins on its own; the PDF composer, loaded with the PDF, addresses it.
    docIdOf, createInDocument: overleafComments.createInDocument, toggleResolved, resolve, reply, reset, load, openComment,
    deleteComment, panelOpen, openPanel, openReply, closePanel, panelFocus, panelFocusId, setPanelFocus,
    activeId, setActiveId, focusRequest, focusHandled,
  };
}

export type EditorComments = ReturnType<typeof useEditorComments>;
