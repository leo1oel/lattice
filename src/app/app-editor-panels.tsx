/**
 * The panels that hang off the editor rather than the project: the editor
 * comment thread list, the TODO scavenger, and the submission checklist.
 *
 * Only the comment list is lazy, so it carries its own `Suspense` rather than
 * sharing one with the other drawers — a `null` fallback that covered all of
 * them would unmount an open TODO panel while an unrelated chunk loads.
 */
import { lazy, Suspense, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { type TodoHit } from "../project/todo-scavenger";
import { TodoScavengerPanel } from "../project/todo-scavenger-panel";
import { isWholeFileEditorPath, toMessage } from "../app-utils";
import { useTrellisController } from "../trellis/trellis-controller";
import { showError } from "./notify";
import type { EditorComments } from "./use-editor-comments";
import type { ToolDrawers } from "./use-tool-drawers";
import { ToolLoadingShell } from "./tool-loading-shell";
import type {
  AppendixBoundary,
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
  /** The document tabs still open; closing the last one leaves `activeFile` set but nothing to return to. */
  openTabs: readonly string[];
  build: BuildResult | null;
  editorCommentAuthorId: string;
  appendixBoundary: AppendixBoundary;
  openProjectFile: OpenProjectFile;
  pdfPageCount: number | null;
  project: ProjectSnapshot;
  projectWordCount: WordCount | null;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  todoHits: TodoHit[];
  tools: Pick<ToolDrawers, "isOpen" | "open" | "close" | "loading">;
  unusedSymbols: UnusedSymbols;
}) {
  const { t } = useLingui();
  const { openProjectFile, project, todoHits, tools, unusedSymbols } = props;
  const trellis = useTrellisController();
  // Where the writer was writing: the active file, still active while a Paper
  // or PDF covers it. A Board, Sheet or Deck has no text to comment on.
  // Closing the last tab keeps the file's buffer (and so `activeFile`) but
  // removes its panel, so only a file still in the tabs is somewhere to return
  // to; without one the action becomes the file picker.
  const writingFile = props.activeFile && props.openTabs.includes(props.activeFile)
    && !isWholeFileEditorPath(props.activeFile) ? props.activeFile : null;
  const returnToEditor = async () => {
    if (!writingFile) {
      trellis?.bridge?.quickOpen();
      return;
    }
    // A Paper or PDF in front gives way to the file, at its remembered caret and scroll.
    if (trellis?.app.get().activeKey !== writingFile) await openProjectFile(writingFile);
    trellis?.focusDocument(writingFile);
  };
  const commentsPanel = (
    <EditorCommentsPanel
      key={comments.panelFocusId ? comments.panelFocus?.nonce : undefined}
      embedded={!!renderCommentsSurface}
      comments={comments.comments}
      activePath={props.activeFile}
      writingFile={writingFile}
      onReturnToEditor={() => void returnToEditor()}
      currentAuthorId={props.editorCommentAuthorId}
      focusCommentId={comments.panelFocusId}
      onClose={comments.closePanel}
      onOpen={comments.openComment}
      onDelete={comments.deleteComment}
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
      {tools.loading === "comments" && (
        renderCommentsSurface
          ? (
            <ToolLoadingShell
              className="overleaf-collab-drawer"
              label={t`Overleaf collaboration`}
              message={t`Loading Overleaf collaboration…`}
              onClose={() => tools.close("comments")}
            />
          ) : (
            <ToolLoadingShell
              className="editor-comments-drawer"
              label={t`Editor comments`}
              message={t`Loading editor comments…`}
              onClose={() => tools.close("comments")}
            />
          )
      )}
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
            words: props.projectWordCount?.total ?? null,
            wordSource: props.projectWordCount?.source ?? "estimate",
            wordBudget: project.manifest.wordBudget ?? null,
            pages: props.pdfPageCount,
            appendix: props.appendixBoundary,
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
              (reason) => showError(toMessage(reason)),
            );
          }}
        />
      )}
    </>
  );
}
