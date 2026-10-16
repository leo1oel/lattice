/**
 * The source editor's extensions, built from a fixed configuration.
 *
 * CodeMirrorHost answers a new extensions identity with a full
 * `StateEffect.reconfigure`, which tears down the language, the linters, the
 * spellchecker and the review and presence layers and builds them again. So
 * the extensions are a function of `SourceSessionConfig` alone, the things
 * that genuinely change what the editor runs: the document, its language, the
 * keymap and spellchecking. Everything else they use (citations, macros,
 * diagnostics, comments, the canvas's handlers) changes while the writer
 * types, so they read it through `SourceSessionLive`'s getters when a handler,
 * transaction or tooltip runs, never while building.
 */
import { linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { AnnotationReviewBridge } from "./annotation-review-bridge";
import type { AnnotationDraft } from "./annotation-composer";
import type { DocumentCanvasProps } from "./canvas-model";
import { isLatexSourcePath } from "./editor-extensions";
import { annotationReviewExtension } from "../editor/annotation-review-anchor";
import { editorCommentsExtension, type CommentCardHosts } from "../editor/comments/editor-comments";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { latexEditorExtensions, textEditorExtensions, type LatexEditorLiveData } from "../editor/latex/latex-editor";
import { latex } from "../editor/latex/latex-language";
import { paperDropExtension } from "../editor/paper-drop";
import { marginReviewExtension, overleafCursorsExtension, overleafTrackChangesExtension } from "../overleaf/overleaf-editor-extensions";
import { editorDiagnosticsForFile } from "../build/compile-diagnostics";
import { editorTexlabDiagnosticsForFile } from "../build/texlab-diagnostics";

/**
 * What the source editor's extensions are built from. Two configurations
 * with the same fields build the same editor; any field changing builds a
 * new one, which the editor takes as a reconfigure.
 */
export type SourceSessionConfig = {
  /** The document, which also decides its language: LaTeX, or `language`. */
  path: string;
  /** Whether Harper checks this document's prose. */
  spellcheck: boolean;
  /** The optional Vim or Emacs keymap, once loaded. */
  keymap: readonly Extension[];
  /** A non-LaTeX document's language, once loaded. */
  language: readonly Extension[];
  // Fixed for the canvas's life; listed so nothing the extensions hold is left out.
  proofread: Extension;
  reviewBridge: AnnotationReviewBridge;
  commentCards: CommentCardHosts;
};

/** The committed values the extensions read when they run. Stable for the canvas's life. */
export type SourceSessionLive = {
  props: () => DocumentCanvasProps;
  /** The open file's comments. */
  comments: () => EditorComment[];
  /** The note being written, in whichever file it was opened. */
  draft: () => AnnotationDraft | null;
  pinLabel: (numbers: number[]) => string;
};

export function sameSourceConfig(a: SourceSessionConfig, b: SourceSessionConfig): boolean {
  return a.path === b.path && a.spellcheck === b.spellcheck && a.keymap === b.keymap && a.language === b.language
    && a.proofread === b.proofread && a.reviewBridge === b.reviewBridge && a.commentCards === b.commentCards;
}

/** The LaTeX and text editors' live data (citations, macros, spelling). */
function editorLiveData(live: SourceSessionLive): { readonly current: LatexEditorLiveData } {
  return {
    get current() {
      const { bibliography, preferences } = live.props();
      return {
        ...bibliography,
        projectRoot: preferences.projectRoot,
        spellingWords: preferences.spellingWords,
        onAddSpellingWord: preferences.onAddSpellingWord,
        englishVariant: preferences.englishVariant,
      };
    },
  };
}

/** Everything the source editor of `config.path` runs, in precedence order. */
export function sourceSessionExtensions(config: SourceSessionConfig, live: SourceSessionLive): Extension[] {
  const { path, spellcheck } = config;
  const latexSource = isLatexSourcePath(path);
  const navigation = () => live.props().navigation;
  const onPasteImage = (file: File) => live.props().assets.onPasteImageFile(file);
  const review = () => live.props().review;
  return [
    paperDropExtension(path, () => ({ projectRoot: live.props().preferences.projectRoot, papers: live.props().bibliography.papers ?? [] })),
    ...config.keymap,
    ...(latexSource ? [
      latex(),
      ...latexEditorExtensions({
        live: editorLiveData(live),
        currentPath: path,
        spellcheck,
        texlab: true,
        loadReferenceImage: (imagePath) => live.props().bibliography.onLoadReferenceImage(imagePath),
        onGotoDefinition: (target) => navigation().onGotoDefinition(target),
        onFindReferences: (target) => navigation().onFindReferences(target),
        onRenameSymbol: (target) => navigation().onRenameSymbol(target),
        onRenameEnvironment: (name) => navigation().onRenameEnvironment(name),
        onWrapEnvironment: () => navigation().onWrapEnvironment(),
        onPasteImage,
        onCreateMissingFile: (missing) => navigation().onCreateMissingFile(missing),
        onTexlabGoto: (target, line, column) => navigation().onTexlabGoto(target, line, column),
      }),
    ] : [
      ...config.language,
      ...textEditorExtensions(spellcheck, editorLiveData(live), onPasteImage),
    ]),
    config.proofread,
    annotationReviewExtension(config.reviewBridge),
    overleafCursorsExtension({ getCursors: () => review().overleafPresenceCursors }),
    overleafTrackChangesExtension({
      getChanges: () => review().overleafChanges,
      authorName: (userId) => review().overleafTrackChangeActions.authorName(userId),
      canAct: () => review().overleafTrackChangeActions.canAct(),
      onAccept: (change) => review().overleafTrackChangeActions.onAccept(change),
      onReject: (change) => review().overleafTrackChangeActions.onReject(change),
    }),
    marginReviewExtension(),
    editorCommentsExtension(path, {
      pinLabel: (numbers) => live.pinLabel(numbers),
      cards: config.commentCards,
      onOpenAnnotation: (comment) => review().annotationRounds.open(comment),
      getComments: live.comments,
      getDraft: live.draft,
    }),
    linter((view) => editorDiagnosticsForFile(live.props().status.buildDiagnostics, path, view.state.doc), { delay: 150 }),
    ...(latexSource ? [linter(
      (view) => editorTexlabDiagnosticsForFile(live.props().status.texlabDiagnostics, path, view.state.doc),
      { delay: 200 },
    )] : []),
  ];
}
