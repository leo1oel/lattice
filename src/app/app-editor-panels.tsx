/**
 * The panels that hang off the editor rather than the project: the
 * Annotations panel and its Revision rounds sheet, the TODO scavenger, the
 * submission checklist, the reviewer's pass over the paper, and the support
 * found for a claim.
 *
 * The annotations, the review and the support are lazy, so each carries its own
 * `Suspense` rather than sharing one with the other drawers — a `null`
 * fallback that covered all of them would unmount an open TODO panel while
 * an unrelated chunk loads.
 */
import { lazy, memo, Suspense, useRef, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { LazyMount } from "../components/lazy-mount";
import { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { useLinkedFileStats } from "../project/submission-item-state";
import { collectFilePaths } from "./workspace-restore";
import { PROJECT_VENUES } from "../project/project-venues";
import { type TodoHit } from "../project/todo-scavenger";
import { TodoScavengerPanel } from "../project/todo-scavenger-panel";
import { isWholeFileEditorPath, toMessage } from "../app-utils";
import { useTrellisController } from "../trellis/trellis-controller";
import { showError } from "./notify";
import type { EditorComments } from "./use-editor-comments";
import type { AnnotationRounds } from "./annotation-rounds";
import type { AnnotationRound, EditorComment } from "../editor/comments/editor-comment-data";
import type { ToolDrawers } from "./use-tool-drawers";
import { ToolLoadingShell } from "./tool-loading-shell";
import type {
  BodyBoundary,
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
const PaperReviewPanel = lazy(() =>
  import("../project/paper-review-panel").then((module) => ({ default: module.PaperReviewPanel })),
);
const SupportPanel = lazy(() =>
  import("../papers/support-panel").then((module) => ({ default: module.SupportPanel })),
);
const AnnotationRoundsDialog = lazy(() =>
  import("../editor/comments/annotation-rounds-dialog").then((module) => ({ default: module.AnnotationRoundsDialog })),
);

/**
 * The Revision rounds sheet, loaded once it is first opened: the rounds'
 * own state says when, so nothing here runs while it stays closed.
 */
const AnnotationRoundsHost = memo(function AnnotationRoundsHost({ rounds, roundsList, annotations }: {
  rounds: AnnotationRounds;
  roundsList: readonly AnnotationRound[];
  annotations: readonly EditorComment[];
}) {
  const open = useSyncExternalStore(rounds.subscribe, () => rounds.getSnapshot().roundsOpen);
  return (
    <LazyMount when={open}>
      <AnnotationRoundsDialog
        rounds={roundsList}
        annotations={annotations}
        readSource={rounds.readSource}
        onOpenInHistory={rounds.openInHistory}
        onRestore={rounds.restore}
        onClose={rounds.closeRounds}
      />
    </LazyMount>
  );
});

export function AppEditorPanels({ comments, annotationRounds, renderCommentsSurface, ...props }: {
  comments: EditorComments;
  annotationRounds: AnnotationRounds;
  /** Wraps the comment list in the Overleaf drawer when the project is linked. */
  renderCommentsSurface?: (localComments: ReactNode) => ReactNode;
  activeFile: string;
  /** The active file's text, for the panel's line numbers and sections. */
  activeSource: string;
  /** The document tabs still open; closing the last one leaves `activeFile` set but nothing to return to. */
  openTabs: readonly string[];
  build: BuildResult | null;
  editorCommentAuthorId: string;
  bodyBoundary: BodyBoundary;
  openProjectFile: OpenProjectFile;
  pdfPageCount: number | null;
  project: ProjectSnapshot;
  /** A check that turns false once the project open now is no longer the one open. */
  captureProjectScope: () => () => boolean;
  projectWordCount: WordCount | null;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  todoHits: TodoHit[];
  tools: Pick<ToolDrawers, "isOpen" | "open" | "close" | "loading">;
  unusedSymbols: UnusedSymbols;
}) {
  const { t } = useLingui();
  const { openProjectFile, project, todoHits, tools, unusedSymbols, activeFile, activeSource } = props;
  const sourceFor = (path: string) => path === activeFile ? activeSource : undefined;
  const trellis = useTrellisController();
  // The budgets and the deadline each answer with the whole manifest, so only
  // the newest write, still in the project it was made for, may install its
  // answer: an older or another project's would replace the name, root
  // documents and every other setting along with the value it changed.
  const manifestWriteRef = useRef(0);
  // Each items write reads the manifest, changes it and writes it back, so
  // two in flight at once (two quick ticks) run one after the other: started
  // together, the older could land last and undo the newer.
  const itemsWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const submissionItems = project.manifest.submissionItems ?? [];
  // The compiled PDF is the usual thing an item is signed off against; it sits
  // beside the root document, though the project tree leaves it out.
  const rootDocument = props.build?.rootDocument
    ?? project.manifest.rootDocuments.find((document) => document.isDefault)?.path;
  const compiledPdf = rootDocument?.replace(/\.tex$/i, ".pdf");
  const linkedFiles = tools.isOpen.checklist
    ? [...new Set(submissionItems.flatMap((item) => item.file ? [item.file] : []))]
    : [];
  const fileStats = useLinkedFileStats(project.root, linkedFiles, project.files, props.build);
  const writeManifest = (write: () => Promise<ProjectManifest>) => {
    const request = ++manifestWriteRef.current;
    const ownsProject = props.captureProjectScope();
    void write().then(
      (manifest) => {
        if (request === manifestWriteRef.current && ownsProject()) {
          props.setProject((current) => current ? { ...current, manifest } : current);
        }
      },
      (reason) => { if (ownsProject()) showError(toMessage(reason)); },
    );
  };
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
      activeCommentId={comments.activeId}
      sourceFor={sourceFor}
      onOpenHighlight={(path, line) => void openProjectFile(path, { line })}
      annotationRounds={annotationRounds}
      roundsList={comments.rounds}
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
              label={t`Annotations`}
              message={t`Loading annotations…`}
              onClose={() => tools.close("comments")}
            />
          )
      )}
      <Suspense fallback={null}>
        {renderCommentsSurface ? renderCommentsSurface(commentsPanel) : comments.panelOpen && commentsPanel}
      </Suspense>
      <AnnotationRoundsHost rounds={annotationRounds} roundsList={comments.rounds} annotations={comments.comments} />
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
      {tools.isOpen.review && (
        <Suspense fallback={null}>
          <PaperReviewPanel
            venue={typeof project.manifest.venue === "string" && project.manifest.venue ? project.manifest.venue : null}
            annotations={comments.comments}
            onClose={() => tools.close("review")}
          />
        </Suspense>
      )}
      {tools.isOpen.support && (
        <Suspense fallback={null}>
          <SupportPanel onClose={() => tools.close("support")} />
        </Suspense>
      )}
      {tools.isOpen.checklist && project && (
        <ManuscriptChecklistPanel
          data={{
            words: props.projectWordCount?.total ?? null,
            wordSource: props.projectWordCount?.source ?? "estimate",
            wordBudget: project.manifest.wordBudget ?? null,
            pages: props.pdfPageCount,
            body: props.bodyBoundary,
            pageBudget: project.manifest.pageBudget ?? null,
            deadline: project.manifest.deadline ?? null,
            venue: PROJECT_VENUES.find((venue) => venue.id === project.manifest.venue)?.label ?? "",
            todos: todoHits.length,
            unusedLabels: unusedSymbols.labels.length,
            unusedCitations: unusedSymbols.citations.length,
            buildOk: props.build ? props.build.success : null,
            buildMessage: props.build?.log?.split("\n").slice(-1)[0] ?? "",
            items: submissionItems,
            fileStats,
            filePaths: [
              ...(compiledPdf && compiledPdf !== rootDocument ? [compiledPdf] : []),
              ...collectFilePaths(project.files, (node) => node.path !== compiledPdf),
            ],
          }}
          onClose={() => tools.close("checklist")}
          // TODOs open beside the checklist, as a tab in its panel (the
          // panel under the pointer), which stays one tab away.
          onOpenTodos={() => tools.open("todos")}
          onSaveBudgets={(wordBudget, pageBudget) => writeManifest(() => invoke<ProjectManifest>("update_project_manifest", {
            wordBudget: wordBudget ?? undefined,
            pageBudget: pageBudget ?? undefined,
            clearWordBudget: wordBudget == null,
            clearPageBudget: pageBudget == null,
          }))}
          onSaveDeadline={(deadline) => writeManifest(() => invoke<ProjectManifest>("set_project_deadline", { deadline }))}
          onSaveItems={(items) => writeManifest(() => {
            const write = itemsWriteRef.current.catch(() => undefined)
              .then(() => invoke<ProjectManifest>("set_submission_items", { items }));
            itemsWriteRef.current = write;
            return write;
          })}
          onOpenFile={(path) => void openProjectFile(path)}
          onOpenSource={(url) => void openUrl(url).catch((reason: unknown) => showError(toMessage(reason)))}
        />
      )}
    </>
  );
}
