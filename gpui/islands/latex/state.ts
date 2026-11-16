/**
 * What the LaTeX island's page holds of its document and the project, and
 * how the owner's messages change it (`main.tsx` lists the protocol): the
 * `doc:open` the page was given, the file as the page has it, and each
 * piece of the Tauri app's live data the owner sends beside it.
 */
import type { EditorView } from "@codemirror/view";
import type { CitationInfo, ReferenceInfo } from "../../../src/editor/latex/latex-text";
import type { CompiledBuild } from "../../../src/editor/latex/compiled-labels";
import type { GrammarIgnores } from "../../../src/editor/harper-spellcheck";
import type { EditorComment } from "../../../src/editor/comments/editor-comment-data";
import type { PresenceCursor } from "../../../src/overleaf/overleaf-editor-extensions";
import type { OutlineNode } from "../../../src/editor/latex/latex-outline";
import type { FileNode } from "../../../src/app-types";
import { NO_OVERLEAF_REVIEW, type OverleafReview } from "./margin-review-data";
import { NO_LIBRARY, NO_REASONS, type CitationLibrary, type CitationReasons } from "./citations";

export type Locale = "en" | "zh-CN";

export type ProjectIndex = { citations: CitationInfo[]; references: ReferenceInfo[]; pending: boolean };

export type Spelling = { enabled: boolean; words: string[]; ignores: GrammarIgnores };
export type Unused = { labels: string[]; citations: string[] };
export type Outline = { nodes: OutlineNode[]; rootPath: string; pdf: string | null };
export type Annotations = { comments: EditorComment[]; author: { id: string; name: string } };

/** Where the reader was: the caret and the line at the top, as offsets into the file. */
export type ViewState = { head: number; top: number };

export type LatexOpen = {
  path: string;
  source: string;
  projectRoot: string;
  viewState?: ViewState | null;
  locale: Locale;
  active: boolean;
  files: FileNode[];
  texSources: string[];
  index: ProjectIndex | null;
  rootDocument: string | null;
  build: CompiledBuild | null;
  spelling: Spelling | null;
  unused: Unused | null;
  outline: Outline | null;
  annotations: Annotations | null;
  presence?: PresenceCursor[];
  overleaf?: OverleafReview | null;
  /** The library and the citation reasons, for the citation cards (`citations.ts`). */
  library?: CitationLibrary | null;
  reasons?: CitationReasons | null;
  /** TexLab is installed: its completion, hovers and definitions join the editor's. */
  texlab: boolean;
};

export type VisualModule = typeof import("../../../src/editor/latex/visual/latex-visual");

export type State = {
  opened: LatexOpen | null;
  /** The file as the page has it: the owner's latest, or the editor's own edit. */
  source: string;
  /** `source` once typing has paused: what the live data is read from. */
  settled: string;
  ready: boolean;
  files: FileNode[];
  texSources: string[];
  index: ProjectIndex;
  rootDocument: string | null;
  build: CompiledBuild | null;
  assetRevision: number;
  /** Visual mode's module, once loaded. */
  visual: VisualModule | null;
  /** The editor, for its overlay scrollbar and outline rail. */
  view: EditorView | null;
  spelling: Spelling;
  unused: Unused;
  outline: Outline;
  annotations: Annotations;
  presence: PresenceCursor[];
  overleaf: OverleafReview;
  library: CitationLibrary;
  reasons: CitationReasons;
};

export type Action =
  | { type: "open"; open: LatexOpen }
  | { type: "source"; source: string }
  | { type: "settle" }
  | { type: "ready" }
  | { type: "project"; files: FileNode[]; texSources: string[] }
  | { type: "index"; index: ProjectIndex }
  | { type: "root"; rootDocument: string | null }
  | { type: "build"; build: CompiledBuild | null }
  | { type: "assets" }
  | { type: "visual"; visual: VisualModule }
  | { type: "view"; view: EditorView }
  | { type: "spelling"; spelling: Spelling }
  | { type: "unused"; unused: Unused }
  | { type: "outline"; outline: Outline }
  | { type: "annotations"; annotations: Annotations }
  | { type: "presence"; presence: PresenceCursor[] }
  | { type: "overleaf"; overleaf: OverleafReview }
  | { type: "library"; library: CitationLibrary }
  | { type: "reasons"; reasons: CitationReasons };

const NO_INDEX: ProjectIndex = { citations: [], references: [], pending: true };
const NO_SPELLING: Spelling = { enabled: false, words: [], ignores: { rules: [], sentences: [] } };
const NO_UNUSED: Unused = { labels: [], citations: [] };
const NO_OUTLINE: Outline = { nodes: [], rootPath: "", pdf: null };
const NO_ANNOTATIONS: Annotations = { comments: [], author: { id: "", name: "" } };

/** The page before its `doc:open`. */
export const INITIAL_STATE: State = {
  opened: null, source: "", settled: "", ready: false, files: [], texSources: [], index: NO_INDEX,
  rootDocument: null, build: null, assetRevision: 0, visual: null, view: null,
  spelling: NO_SPELLING, unused: NO_UNUSED, outline: NO_OUTLINE, annotations: NO_ANNOTATIONS, presence: [],
  overleaf: NO_OVERLEAF_REVIEW, library: NO_LIBRARY, reasons: NO_REASONS,
};

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return {
        ...state,
        opened: action.open,
        source: action.open.source,
        settled: action.open.source,
        files: action.open.files,
        texSources: action.open.texSources,
        index: action.open.index ?? NO_INDEX,
        rootDocument: action.open.rootDocument,
        build: action.open.build,
        spelling: action.open.spelling ?? NO_SPELLING,
        unused: action.open.unused ?? NO_UNUSED,
        outline: action.open.outline ?? NO_OUTLINE,
        annotations: action.open.annotations ?? NO_ANNOTATIONS,
        presence: action.open.presence ?? [],
        overleaf: action.open.overleaf ?? NO_OVERLEAF_REVIEW,
        library: action.open.library ?? NO_LIBRARY,
        reasons: action.open.reasons ?? NO_REASONS,
      };
    case "source":
      return { ...state, source: action.source };
    case "settle":
      return { ...state, settled: state.source };
    case "ready":
      return { ...state, ready: true };
    case "project":
      return { ...state, files: action.files, texSources: action.texSources };
    case "index":
      return { ...state, index: action.index };
    case "root":
      return { ...state, rootDocument: action.rootDocument };
    case "build":
      return { ...state, build: action.build };
    case "assets":
      return { ...state, assetRevision: state.assetRevision + 1 };
    case "visual":
      return { ...state, visual: action.visual };
    case "view":
      return { ...state, view: action.view };
    case "spelling":
      return { ...state, spelling: action.spelling };
    case "unused":
      return { ...state, unused: action.unused };
    case "outline":
      return { ...state, outline: action.outline };
    case "annotations":
      return { ...state, annotations: action.annotations };
    case "presence":
      return { ...state, presence: action.presence };
    case "overleaf":
      return { ...state, overleaf: action.overleaf };
    case "library":
      return { ...state, library: action.library };
    case "reasons":
      return { ...state, reasons: action.reasons };
  }
}
