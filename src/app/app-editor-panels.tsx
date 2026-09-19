/**
 * The panels that hang off the editor rather than the project: the editor
 * comment thread list, the TODO scavenger, and the submission checklist.
 *
 * Only the comment list is lazy, so it carries its own `Suspense` rather than
 * sharing one with the other drawers — a `null` fallback that covered all of
 * them would unmount an open TODO panel while an unrelated chunk loads.
 */
import { lazy, Suspense, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { type EditorComment } from "../editor/comments/editor-comment-data";
import { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { type TodoHit } from "../project/todo-scavenger";
import { TodoScavengerPanel } from "../project/todo-scavenger-panel";
import { confirmAction, toMessage } from "../app-utils";
import { setError } from "./notify";
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
  renderCommentsSurface?: (localComments: ReactNode) => ReactNode;
  build: BuildResult | null;
  checklistOpen: boolean;
  commentOpenGenerationRef: RefObject<number>;
  commentPanelFocusId: string | null;
  commentPanelFocusNonce?: string;
  editorCommentAuthorId: string;
  editorComments: EditorComment[];
  editorCommentsOpen: boolean;
  mainBodyPages: number | null;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
  onCloseComments: () => void;
  pdfPageCount: number | null;
  persistEditorComments: (next: EditorComment[]) => Promise<void>;
  project: ProjectSnapshot;
  projectWordCount: WordCount | null;
  refreshTodos: () => Promise<void>;
  replyToEditorComment: (commentId: string, body: string) => void;
  setActiveEditorCommentId: Dispatch<SetStateAction<string | null>>;
  setChecklistOpen: Dispatch<SetStateAction<boolean>>;
  setCommentFocusRequest: Dispatch<SetStateAction<{ id: string; nonce: string; } | null>>;
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
    renderCommentsSurface,
    build,
    checklistOpen,
    commentOpenGenerationRef,
    commentPanelFocusId,
    editorCommentAuthorId,
    editorComments,
    editorCommentsOpen,
    mainBodyPages,
    openProjectFile,
    onCloseComments,
    pdfPageCount,
    persistEditorComments,
    project,
    projectWordCount,
    refreshTodos,
    replyToEditorComment,
    setActiveEditorCommentId,
    setChecklistOpen,
    setCommentFocusRequest,
    setProject,
    setTodosOpen,
    todoHits,
    todosOpen,
    toggleEditorCommentResolved,
    unusedSymbols,
  } = props;
  const commentsPanel = (
    <EditorCommentsPanel
      key={props.commentPanelFocusNonce}
      embedded={!!renderCommentsSurface}
      comments={editorComments}
      activePath={activeFile}
      currentAuthorId={editorCommentAuthorId}
      focusCommentId={commentPanelFocusId}
      onClose={onCloseComments}
      onOpen={(comment) => {
        const generation = commentOpenGenerationRef.current + 1;
        commentOpenGenerationRef.current = generation;
        setActiveEditorCommentId(comment.id);
        onCloseComments();
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
          await persistEditorComments(editorComments.filter((comment) => comment.id !== id));
          setActiveEditorCommentId((current) => (current === id ? null : current));
        })();
      }}
      onToggleResolved={(comment) => toggleEditorCommentResolved(comment.id)}
      onUpdateBody={(comment, body) => {
        const trimmed = body.trim();
        if (!trimmed) return;
        void persistEditorComments(editorComments.map((item) => (
          item.id === comment.id
            ? { ...item, body: trimmed, updatedAt: new Date().toISOString() }
            : item
        )));
      }}
      onReply={(comment, body) => replyToEditorComment(comment.id, body)}
    />
  );
  return (
    <>
      <Suspense fallback={null}>
        {renderCommentsSurface ? renderCommentsSurface(commentsPanel) : editorCommentsOpen && commentsPanel}
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
