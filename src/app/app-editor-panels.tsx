/**
 * The panels that hang off the editor rather than the project: the
 * Annotations panel and its Revision rounds sheet, the TODO scavenger, and
 * the submission checklist.
 *
 * The annotations are lazy, so they carry their own `Suspense` rather than
 * sharing one with the other drawers — a `null` fallback that covered all of
 * them would unmount an open TODO panel while an unrelated chunk loads.
 */
import { lazy, memo, Suspense, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { LazyMount } from "../components/lazy-mount";
import { useProjectFigureUndo } from "../project/figure-undo";
import { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { useLinkedFileStats } from "../project/submission-item-state";
import { useSubmissionReview } from "../project/submission-review-state";
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
  SubmissionItem,
  UnusedSymbols,
  WordCount,
} from "../app-types";

const EMPTY_ITEMS: SubmissionItem[] = [];
const FigureInventoryDialog = lazy(() => import("../project/figure-inventory-dialog").then((module) => ({ default: module.FigureInventoryDialog })));

const EditorCommentsPanel = lazy(() =>
  import("../editor/comments/editor-comments-panel").then((module) => ({ default: module.EditorCommentsPanel })),
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
  openFigureFile: OpenProjectFile;
  beforeFigureWrite: () => Promise<boolean>;
  afterFigureWrite: () => Promise<void>;
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
  const [figuresOpen, setFiguresOpen] = useState(false);
  const { openProjectFile, project, todoHits, tools, unusedSymbols, activeFile, activeSource } = props;
  const [figureUndo, setFigureUndo] = useProjectFigureUndo(project.root);
  const sourceFor = (path: string) => path === activeFile ? activeSource : undefined;
  const trellis = useTrellisController();
  // The budgets, the deadline and the items each read the manifest, change it
  // and write it back, so they run one after the other: two in flight at once
  // (a quick tick while the deadline saves) could each read the file before
  // the other wrote it, and the one landing last would undo the other. Run in
  // order, they answer in order, so every answer still in the project it was
  // made for is installed.
  const manifestQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const submissionItems = project.manifest.submissionItems ?? EMPTY_ITEMS;
  // The compiled PDF is the usual thing an item is signed off against; it sits
  // beside the root document, though the project tree leaves it out.
  const rootDocument = props.build?.rootDocument
    ?? project.manifest.rootDocuments.find((document) => document.isDefault)?.path;
  const compiledPdf = rootDocument?.replace(/\.tex$/i, ".pdf");
  const linkedFiles = tools.isOpen.checklist
    ? [...new Set(submissionItems.flatMap((item) => item.file ? [item.file] : []))]
    : [];
  const fileStats = useLinkedFileStats(project.root, linkedFiles, project.files, props.build);
  const review = useSubmissionReview(project.root, tools.isOpen.checklist, project.files, props.build);
  // Answers whether the write was made. The commands write to whichever
  // project is open when they run, so one whose turn comes after its project
  // closed is never sent.
  const writeManifest = (write: () => Promise<ProjectManifest>): Promise<boolean> => {
    const ownsProject = props.captureProjectScope();
    const queued = manifestQueueRef.current.catch(() => undefined)
      .then(() => ownsProject() ? write() : null);
    manifestQueueRef.current = queued;
    return queued.then(
      (manifest) => {
        if (manifest && ownsProject()) {
          props.setProject((current) => current ? { ...current, manifest } : current);
        }
        return !!manifest;
      },
      (reason) => {
        if (ownsProject()) showError(toMessage(reason));
        return false;
      },
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
      {figuresOpen && <Suspense fallback={null}><FigureInventoryDialog
        key={project.root} project={project} activeFile={activeFile} activeSource={activeSource} onOpen={props.openFigureFile}
        onClose={() => setFiguresOpen(false)} beforeWrite={props.beforeFigureWrite} afterWrite={props.afterFigureWrite}
        captureProjectScope={props.captureProjectScope} undo={figureUndo} setUndo={setFigureUndo}
      /></Suspense>}
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
            review,
          }}
          onClose={() => tools.close("checklist")}
          // TODOs open beside the checklist, as a tab in its panel (the
          // panel under the pointer), which stays one tab away.
          onOpenTodos={() => tools.open("todos")}
          onOpenFigures={() => setFiguresOpen(true)}
          onSaveBudgets={(wordBudget, pageBudget) => void writeManifest(() => invoke<ProjectManifest>("update_project_manifest", {
            wordBudget: wordBudget ?? undefined,
            pageBudget: pageBudget ?? undefined,
            clearWordBudget: wordBudget == null,
            clearPageBudget: pageBudget == null,
          }))}
          onSaveDeadline={(deadline) => writeManifest(() => invoke<ProjectManifest>("set_project_deadline", { deadline }))}
          onSaveItems={(items) => writeManifest(() => invoke<ProjectManifest>("set_submission_items", { items }))}
          onOpenFile={(path) => void openProjectFile(path)}
          onOpenAt={(path, line) => void openProjectFile(path, { line })}
          onOpenSource={(url) => void openUrl(url).catch((reason: unknown) => showError(toMessage(reason)))}
        />
      )}
    </>
  );
}
