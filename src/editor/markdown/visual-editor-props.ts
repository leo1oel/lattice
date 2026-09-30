/**
 * Lattice's host contract for visual Markdown editing: the props the document
 * canvas hands the visual editor, so the canvas needs nothing of the engine
 * behind it.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { PaperSummary } from "../../app-types";
import type { PresenceCursor, TrackedChangeTooltipActions } from "../../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../../overleaf/use-overleaf-realtime";
import type { EditorComment } from "../comments/editor-comment-data";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";

export type VisualMarkdownEditorProps = {
  text: string;
  activePath: string;
  projectRoot?: string;
  onChangeMarkdown: (next: string, expected: string) => boolean;
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  optimizeForReading?: boolean;
  /** Lets a parent place the eligibility notice outside the article body. */
  onEligibilityChange?: (reason: string | null) => void;
  synchronizeSourceScroll?: boolean;
  onRequestViewportLock?: (anchor: HTMLElement | null, anchorTop: number | null, reveal: HTMLElement | null) => void;
  onOpenProjectPath?: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  /** Downloaded paper library backing the `@` citation typeahead. */
  papers?: PaperSummary[];
  macros?: Record<string, string>;
  onUndo: () => boolean;
  onRedo: () => boolean;
  onEditSource?: () => void;
  onViewInSource?: (sourceOffset: number, viewportY?: number, blockViewportY?: number) => void;
  onImportAsset?: (file: File) => Promise<string | null>;
  onLoadAsset?: (path: string) => Promise<string | null>;
  assetRevision?: number;
  presenceCursors?: PresenceCursor[];
  onCaretChange?: (row: number, column: number) => void;
  onSelectionMarkdown?: (value: string) => void;
  overleafChanges?: TrackedChange[];
  /** Comments anchored in this file, painted as highlights over the prose. */
  editorComments?: EditorComment[];
  activeEditorCommentId?: string | null;
  onEditorCommentClick?: (id: string) => void;
  overleafTrackChangeActions?: TrackedChangeTooltipActions;
  onCreateComment?: (from: number, to: number, body: string) => void;
  editable?: boolean;
};
