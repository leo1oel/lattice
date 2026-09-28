import { Suspense, useCallback, useLayoutEffect, useRef, type ComponentProps } from "react";
import { ScrollArea } from "../components/ui/scroll-area";
import type { EditorComment } from "../editor/comments/editor-comments";
import { markdownFrontmatterEnd } from "../app-utils";
import { DeferredVisualMarkdownEditor, MarkdownPreviewLoading } from "./canvas-lazy-editors";
import { rangesWithinPreview, spliceMarkdownBody, useSettledPreviewText } from "./markdown-preview-sync";

/** Visual-editor props the canvas hands both panes' Markdown editors unchanged. */
type ForwardedEditorProps = Pick<
  ComponentProps<typeof DeferredVisualMarkdownEditor>,
  | "onFlushPendingChange" | "onOpenProjectPath" | "workspaceIndex" | "papers" | "macros" | "onImportAsset" | "onLoadAsset"
  | "assetRevision" | "editable" | "onSelectionMarkdown" | "activeEditorCommentId" | "onEditorCommentClick"
>;

/**
 * The visual Markdown editor for the secondary pane: it edits the secondary
 * buffer directly and keeps its own undo history, with no CodeMirror view behind it.
 */
export function SecondaryMarkdownPreview({
  path, projectRoot, source, onChange, onEditSource, onCaretChange, editorComments, onCreateComment, ...forwarded
}: ForwardedEditorProps & {
  path: string;
  projectRoot: string;
  source: string;
  onChange: (next: string) => void;
  onEditSource: () => void;
  onCaretChange: (row: number, column: number) => void;
  editorComments: EditorComment[];
  onCreateComment: (from: number, to: number, body: string) => void;
}) {
  const sourceRef = useRef(source);
  const onChangeRef = useRef(onChange);
  const historyRef = useRef<{ undo: string[]; redo: string[] }>({ undo: [], redo: [] });
  useLayoutEffect(() => {
    sourceRef.current = source;
    onChangeRef.current = onChange;
  }, [onChange, source]);

  const previewStart = markdownFrontmatterEnd(source);
  const { settled: settledText, markEcho } = useSettledPreviewText(source, source.slice(previewStart), path);
  const lineOffset = source.slice(0, previewStart).split("\n").length - 1;

  const publishSource = useCallback((nextSource: string) => {
    sourceRef.current = nextSource;
    markEcho(nextSource);
    onChangeRef.current(nextSource);
  }, [markEcho]);
  const replaceMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    const current = sourceRef.current;
    const splice = spliceMarkdownBody(current, markdownFrontmatterEnd(current), expectedBody, nextBody);
    if (!splice) return false;
    historyRef.current.undo.push(current);
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
          {...forwarded}
          text={settledText}
          activePath={path}
          projectRoot={projectRoot}
          synchronizeSourceScroll={false}
          onChangeMarkdown={replaceMarkdown}
          onUndo={undo}
          onRedo={redo}
          onEditSource={onEditSource}
          onViewInSource={onEditSource}
          onCaretChange={(row, column) => onCaretChange(row + lineOffset, column)}
          editorComments={rangesWithinPreview(editorComments, previewStart, source.length)}
          onCreateComment={(from, to, body) => onCreateComment(previewStart + from, previewStart + to, body)}
        />
      </Suspense>
    </ScrollArea>
  );
}
