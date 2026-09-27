import { Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { ScrollArea } from "../components/ui/scroll-area";
import { markdownPreviewSyncPolicy } from "../editor/markdown/markdown-preview-sync-policy";
import type { MarkdownWorkspaceIndex } from "../editor/markdown/markdown-workspace-index";
import type { EditorComment } from "../editor/comments/editor-comments";
import { markdownFrontmatterEnd } from "../app-utils";
import type { PaperSummary } from "../app-types";
import { DeferredVisualMarkdownEditor, MarkdownPreviewLoading } from "./canvas-lazy-editors";
import { rangesWithinPreview, spliceMarkdownBody, useSettledPreviewText } from "./markdown-preview-sync";

/**
 * The visual Markdown editor for the secondary pane. It edits the secondary
 * buffer directly and keeps its own undo history, since that pane has no
 * CodeMirror view behind it to own one.
 */
export function SecondaryMarkdownPreview(props: {
  path: string;
  projectRoot: string;
  source: string;
  onChange: (next: string) => void;
  onFlushPendingChange: (flush: (() => boolean) | null) => void;
  onEditSource: () => void;
  onOpenProjectPath: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  papers?: PaperSummary[];
  macros: Record<string, string>;
  onImportAsset?: (file: File) => Promise<string | null>;
  onLoadAsset: (path: string) => Promise<string | null>;
  assetRevision: number;
  editable: boolean;
  onCaretChange: (row: number, column: number) => void;
  onSelectionMarkdown: (value: string) => void;
  editorComments: EditorComment[];
  activeEditorCommentId: string | null;
  onEditorCommentClick: (id: string) => void;
  onCreateComment: (from: number, to: number, body: string) => void;
}) {
  const sourceRef = useRef(props.source);
  const onChangeRef = useRef(props.onChange);
  const [visualEchoSource, setVisualEchoSource] = useState<string | null>(null);
  const historyRef = useRef<{ undo: string[]; redo: string[] }>({ undo: [], redo: [] });
  useLayoutEffect(() => {
    sourceRef.current = props.source;
    onChangeRef.current = props.onChange;
  }, [props.onChange, props.source]);

  const previewStart = markdownFrontmatterEnd(props.source);
  const previewText = props.source.slice(previewStart);
  const syncPolicy = markdownPreviewSyncPolicy(previewText.length);
  const settledText = useSettledPreviewText(
    previewText,
    props.source === visualEchoSource,
    props.path,
    syncPolicy.publicationIdleMs,
    syncPolicy.publicationMaxMs,
  );
  const lineOffset = props.source.slice(0, previewStart).split("\n").length - 1;

  const publishSource = useCallback((nextSource: string) => {
    sourceRef.current = nextSource;
    setVisualEchoSource(nextSource);
    onChangeRef.current(nextSource);
  }, []);
  const replaceMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    const source = sourceRef.current;
    const splice = spliceMarkdownBody(source, markdownFrontmatterEnd(source), expectedBody, nextBody);
    if (!splice) return false;
    historyRef.current.undo.push(source);
    historyRef.current.redo = [];
    publishSource(`${splice.prefix}${splice.inserted}`);
    return true;
  }, [publishSource]);
  const step = useCallback((from: "undo" | "redo", to: "undo" | "redo") => {
    const target = historyRef.current[from].pop();
    if (target === undefined) return false;
    historyRef.current[to].push(sourceRef.current);
    publishSource(target);
    return true;
  }, [publishSource]);
  const undo = useCallback(() => step("undo", "redo"), [step]);
  const redo = useCallback(() => step("redo", "undo"), [step]);

  return (
    <ScrollArea
      className="markdown-preview secondary-markdown-preview"
      orientation="vertical"
      fadeEdges={false}
      contentClassName="markdown-preview-content"
      viewportClassName="editor-doc-scroll"
      viewportProps={{ "data-testid": "editor-scroll-container" }}
    >
      <Suspense fallback={<MarkdownPreviewLoading />}>
        <DeferredVisualMarkdownEditor
          text={settledText}
          activePath={props.path}
          projectRoot={props.projectRoot}
          synchronizeSourceScroll={false}
          onOpenProjectPath={props.onOpenProjectPath}
          workspaceIndex={props.workspaceIndex}
          papers={props.papers}
          macros={props.macros}
          onChangeMarkdown={replaceMarkdown}
          onFlushPendingChange={props.onFlushPendingChange}
          onUndo={undo}
          onRedo={redo}
          onEditSource={props.onEditSource}
          onViewInSource={props.onEditSource}
          onImportAsset={props.onImportAsset}
          onLoadAsset={props.onLoadAsset}
          assetRevision={props.assetRevision}
          editable={props.editable}
          onCaretChange={(row, column) => props.onCaretChange(row + lineOffset, column)}
          onSelectionMarkdown={props.onSelectionMarkdown}
          editorComments={rangesWithinPreview(props.editorComments, previewStart, props.source.length)}
          activeEditorCommentId={props.activeEditorCommentId}
          onEditorCommentClick={props.onEditorCommentClick}
          onCreateComment={(from, to, body) => props.onCreateComment(previewStart + from, previewStart + to, body)}
        />
      </Suspense>
    </ScrollArea>
  );
}
