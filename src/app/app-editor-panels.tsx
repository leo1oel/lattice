/**
 * The panels that hang off the editor rather than the project: the editor
 * comment thread list, the TODO scavenger, and the submission checklist.
 *
 * Only the comment list is lazy, so it carries its own `Suspense` rather than
 * sharing one with the other drawers — a `null` fallback that covered all of
 * them would unmount an open TODO panel while an unrelated chunk loads.
 */
import { lazy, Suspense, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { type EditorComment } from "../editor/comments/editor-comment-data";
import { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { type TodoHit } from "../project/todo-scavenger";
import { TodoScavengerPanel } from "../project/todo-scavenger-panel";
import { confirmAction, toMessage } from "../app-utils";
import { setError } from "./notify";
import type { OverleafComments } from "../overleaf/use-overleaf-comments";
import type {
  BuildResult,
  EditorPaneId,
  ProjectManifest,
  ProjectSnapshot,
  UnusedSymbols,
  WordCount,
} from "../app-types";

const EditorCommentsPanel = lazy(() =>
  import("../editor/comments/editor-comments-panel").then((module) => ({ default: module.EditorCommentsPanel })),
);

export type AppEditorPanelsProps = {
  activeFile: string;
  activeFileRef: RefObject<string>;
  allEditorComments: EditorComment[];
  build: BuildResult | null;
  checklistOpen: boolean;
  commentOpenGenerationRef: RefObject<number>;
  commentPanelFocusId: string | null;
  editorCommentAuthorId: string;
  editorComments: EditorComment[];
  editorCommentsOpen: boolean;
  mainBodyPages: number | null;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
  overleafComments: OverleafComments;
  overleafThreadOf: (commentId: string) => string | null;
  pdfPageCount: number | null;
  persistEditorComments: (next: EditorComment[]) => Promise<void>;
  project: ProjectSnapshot;
  projectWordCount: WordCount | null;
  refreshTodos: () => Promise<void>;
  replyToEditorComment: (commentId: string, body: string) => void;
  setActiveEditorCommentId: Dispatch<SetStateAction<string | null>>;
  setChecklistOpen: Dispatch<SetStateAction<boolean>>;
  setCommentFocusRequest: Dispatch<SetStateAction<{ id: string; nonce: string; } | null>>;
  setCommentPanelFocusId: Dispatch<SetStateAction<string | null>>;
  setEditorCommentsOpen: Dispatch<SetStateAction<boolean>>;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  setTodosOpen: Dispatch<SetStateAction<boolean>>;
  todoHits: TodoHit[];
  todosOpen: boolean;
  toggleEditorCommentResolved: (id: string) => void;
  unusedSymbols: UnusedSymbols;
};

export function AppEditorPanels(props: AppEditorPanelsProps) {
  const { t } = useLingui();
  const {
    activeFile,
    activeFileRef,
    allEditorComments,
    build,
    checklistOpen,
    commentOpenGenerationRef,
    commentPanelFocusId,
    editorCommentAuthorId,
    editorComments,
    editorCommentsOpen,
    mainBodyPages,
    openProjectFile,
    overleafComments,
    overleafThreadOf,
    pdfPageCount,
    persistEditorComments,
    project,
    projectWordCount,
    refreshTodos,
    replyToEditorComment,
    setActiveEditorCommentId,
    setChecklistOpen,
    setCommentFocusRequest,
    setCommentPanelFocusId,
    setEditorCommentsOpen,
    setProject,
    setTodosOpen,
    todoHits,
    todosOpen,
    toggleEditorCommentResolved,
    unusedSymbols,
  } = props;
  return (
    <>
      <Suspense fallback={null}>
      {editorCommentsOpen && (
        <EditorCommentsPanel
          comments={allEditorComments}
          activePath={activeFile}
          currentAuthorId={editorCommentAuthorId}
          focusCommentId={commentPanelFocusId}
          onClose={() => {
            setEditorCommentsOpen(false);
            setCommentPanelFocusId(null);
          }}
          onOpen={(comment) => {
            const generation = commentOpenGenerationRef.current + 1;
            commentOpenGenerationRef.current = generation;
            setActiveEditorCommentId(comment.id);
            setEditorCommentsOpen(false);
            setCommentPanelFocusId(null);
            void openProjectFile(comment.path).then(() => {
              if (
                commentOpenGenerationRef.current !== generation
                || activeFileRef.current !== comment.path
              ) return;
              setCommentFocusRequest({ id: comment.id, nonce: crypto.randomUUID() });
            });
          }}
          onDelete={(id) => {
            void (async () => {
              if (!await confirmAction(
                t`Delete this comment? Its replies will be removed too. This cannot be undone.`,
              )) {
                return;
              }
              const threadId = overleafThreadOf(id);
              if (threadId) {
                await overleafComments.remove(threadId).catch((reason) => setError(toMessage(reason)));
                return;
              }
              await persistEditorComments(editorComments.filter((comment) => comment.id !== id));
              setActiveEditorCommentId((current) => (current === id ? null : current));
            })();
          }}
          onToggleResolved={(comment) => toggleEditorCommentResolved(comment.id)}
          onUpdateBody={(comment, body) => {
            const trimmed = body.trim();
            if (!trimmed) return;
            // Overleaf's threads are edited where they live; changing the text
            // of someone else's first message is not ours to do from here.
            if (overleafThreadOf(comment.id)) return;
            void persistEditorComments(editorComments.map((item) => (
              item.id === comment.id
                ? { ...item, body: trimmed, updatedAt: new Date().toISOString() }
                : item
            )));
          }}
          onReply={(comment, body) => replyToEditorComment(comment.id, body)}
        />
      )}
      </Suspense>
      {todosOpen && (
        <TodoScavengerPanel
          hits={todoHits}
          onClose={() => setTodosOpen(false)}
          onOpen={(path, line) => {
            void openProjectFile(path, line);
            setTodosOpen(false);
          }}
        />
      )}
      {checklistOpen && project && (
        <ManuscriptChecklistPanel
          data={{
            words: projectWordCount?.total ?? 0,
            wordSource: projectWordCount?.source ?? "estimate",
            wordBudget: project.manifest.wordBudget ?? null,
            pages: pdfPageCount,
            mainPages: mainBodyPages,
            pageBudget: project.manifest.pageBudget ?? null,
            todos: todoHits.length,
            unusedLabels: unusedSymbols.labels.length,
            unusedCitations: unusedSymbols.citations.length,
            buildOk: build ? build.success : null,
            buildMessage: build?.log?.split("\n").slice(-1)[0] ?? "",
          }}
          onClose={() => setChecklistOpen(false)}
          onOpenTodos={() => {
            setChecklistOpen(false);
            void refreshTodos();
            setTodosOpen(true);
          }}
          onSaveBudgets={(wordBudget, pageBudget) => {
            void (async () => {
              try {
                const manifest = await invoke<ProjectManifest>("update_project_manifest", {
                  wordBudget: wordBudget ?? undefined,
                  pageBudget: pageBudget ?? undefined,
                  clearWordBudget: wordBudget == null,
                  clearPageBudget: pageBudget == null,
                });
                setProject((current) => current ? { ...current, manifest } : current);
              } catch (reason) {
                setError(toMessage(reason));
              }
            })();
          }}
        />
      )}
    </>
  );
}
