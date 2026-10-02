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
import { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { type TodoHit } from "../project/todo-scavenger";
import { TodoScavengerPanel } from "../project/todo-scavenger-panel";
import { toMessage } from "../app-utils";
import { setError } from "./notify";
import { notifyInfo } from "../telemetry/app-notify";
import type { EditorComments } from "./use-editor-comments";
import type { ToolDrawers } from "./use-tool-drawers";
import type {
  BuildResult,
  OpenProjectFile,
  ProjectManifest,
  ProjectSnapshot,
  UnusedSymbols,
  WordCount,
} from "../app-types";

const EditorCommentsPanel = lazy(() =>
  import("../editor/comments/editor-comments-panel").then((module) => ({ default: module.EditorCommentsPanel })),
);

export function AppEditorPanels({ comments, renderCommentsSurface, ...props }: {
  comments: EditorComments;
  /** Wraps the comment list in the Overleaf drawer when the project is linked. */
  renderCommentsSurface?: (localComments: ReactNode) => ReactNode;
  activeFile: string;
  activeFileRef: RefObject<string>;
  build: BuildResult | null;
  editorCommentAuthorId: string;
  mainBodyPages: number | null;
  openProjectFile: OpenProjectFile;
  pdfPageCount: number | null;
  project: ProjectSnapshot;
  projectWordCount: WordCount | null;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  todoHits: TodoHit[];
  tools: Pick<ToolDrawers, "isOpen" | "open" | "close">;
  unusedSymbols: UnusedSymbols;
}) {
  const { t } = useLingui();
  const { openProjectFile, project, todoHits, tools, unusedSymbols } = props;
  const { openGenerationRef, setActiveId } = comments;
  const commentsPanel = (
    <EditorCommentsPanel
      key={comments.panelFocusId ? comments.panelFocus?.nonce : undefined}
      embedded={!!renderCommentsSurface}
      comments={comments.comments}
      activePath={props.activeFile}
      currentAuthorId={props.editorCommentAuthorId}
      focusCommentId={comments.panelFocusId}
      onClose={comments.closePanel}
      onOpen={(comment) => {
        const generation = ++openGenerationRef.current;
        setActiveId(comment.id);
        comments.closePanel();
        void openProjectFile(comment.path).then(() => {
          if (openGenerationRef.current !== generation || props.activeFileRef.current !== comment.path) return;
          comments.setFocusRequest({ id: comment.id, nonce: crypto.randomUUID() });
        });
      }}
      onDelete={(id) => {
        // Deleted at once, with an Undo, rather than behind a confirmation:
        // the comment and its replies are local and can be put back.
        const undo = comments.remove(id);
        setActiveId((current) => (current === id ? null : current));
        if (undo) {
          notifyInfo(t`Comments`, t`Comment deleted`, {
            dedupeKey: `editor-comment-deleted:${id}`,
            primaryAction: { label: t`Undo`, onClick: undo },
          });
        }
      }}
      onToggleResolved={(comment) => comments.toggleResolved(comment.id)}
      onUpdateBody={(comment, body) => {
        const trimmed = body.trim();
        if (trimmed) comments.update(comment.id, () => ({ body: trimmed }));
      }}
      onReply={(comment, body) => comments.reply(comment.id, body)}
    />
  );
  return (
    <>
      <Suspense fallback={null}>
        {renderCommentsSurface ? renderCommentsSurface(commentsPanel) : comments.panelOpen && commentsPanel}
      </Suspense>
      {tools.isOpen.todos && (
        <TodoScavengerPanel
          hits={todoHits}
          onClose={() => tools.close("todos")}
          onOpen={(path, line) => {
            void openProjectFile(path, { line });
            tools.close("todos");
          }}
        />
      )}
      {tools.isOpen.checklist && project && (
        <ManuscriptChecklistPanel
          data={{
            words: props.projectWordCount?.total ?? 0,
            wordSource: props.projectWordCount?.source ?? "estimate",
            wordBudget: project.manifest.wordBudget ?? null,
            pages: props.pdfPageCount,
            mainPages: props.mainBodyPages,
            pageBudget: project.manifest.pageBudget ?? null,
            todos: todoHits.length,
            unusedLabels: unusedSymbols.labels.length,
            unusedCitations: unusedSymbols.citations.length,
            buildOk: props.build ? props.build.success : null,
            buildMessage: props.build?.log?.split("\n").slice(-1)[0] ?? "",
          }}
          onClose={() => tools.close("checklist")}
          onOpenTodos={() => {
            tools.close("checklist");
            tools.open("todos");
          }}
          onSaveBudgets={(wordBudget, pageBudget) => {
            void invoke<ProjectManifest>("update_project_manifest", {
              wordBudget: wordBudget ?? undefined,
              pageBudget: pageBudget ?? undefined,
              clearWordBudget: wordBudget == null,
              clearPageBudget: pageBudget == null,
            }).then(
              (manifest) => props.setProject((current) => current ? { ...current, manifest } : current),
              (reason) => setError(toMessage(reason)),
            );
          }}
        />
      )}
    </>
  );
}
