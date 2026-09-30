import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { ListTodo, MessageSquareText } from "lucide-react";
import { countWords, textStats } from "../editor/latex/latex-edits";
import type { OutlineNode } from "../editor/latex/latex-outline";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { EditorKeymap, WordCount } from "../app-types";

/** Caret position, Vim mode, section breadcrumb, shortcuts, comments/TODOs, and word counts for the focused editor. */
export function EditorStatusBar(props: {
  position: { line: number; column: number };
  onGotoLine: () => void;
  keymap: EditorKeymap;
  vimMode: string;
  breadcrumb: OutlineNode[];
  /** File a breadcrumb entry without a path of its own belongs to. */
  breadcrumbPath: string;
  onNavigate: (path: string, line: number) => void;
  hasDiagnostics: boolean;
  comments: EditorComment[];
  onOpenComments: () => void;
  todoCount: number;
  onOpenTodos: () => void;
  projectWordCount: WordCount | null;
  selectedText: string;
  source: string;
}) {
  const { position, breadcrumb, todoCount, projectWordCount, selectedText, source } = props;
  const { t } = useLingui();
  const wordCount = useMemo(() => countWords(source), [source]);
  const selectionStats = useMemo(() => textStats(selectedText), [selectedText]);
  const openComments = props.comments.filter((comment) => !comment.resolved).length;
  return (
    <div className="editor-status-bar" aria-label={t`Editor status`}>
      <button type="button" className="status-goto" title={t`Go to line (⌘G)`} onClick={props.onGotoLine}>
        {t({ message: `Ln ${{ line: position.line }}, Col ${{ column: position.column + 1 }}` })}
      </button>
      {props.keymap === "vim" && (
        <span className="status-vim-mode" aria-live="polite" title={t`Vim mode`}>
          --{props.vimMode.toUpperCase()}--
        </span>
      )}
      {breadcrumb.length > 0 && (
        <span className="editor-breadcrumb" title={breadcrumb.map((node) => node.title).join(" › ")}>
          {breadcrumb.map((node, index) => (
            <span key={node.id}>
              {index > 0 && <i aria-hidden="true">›</i>}
              <button
                type="button"
                title={t({ message: `Go to ${{ title: node.title }}` })}
                onClick={() => props.onNavigate(node.path || props.breadcrumbPath, node.line)}
              >
                {node.title}
              </button>
            </span>
          ))}
        </span>
      )}
      <span className="status-hint" title={t`Editor shortcuts`}>
        {props.hasDiagnostics
          // eslint-disable-next-line lingui/no-unlocalized-strings -- key name
          ? <><kbd>F8</kbd> {t`next`} · <kbd>⇧F8</kbd> {t`previous`}</>
          : <><kbd>⌘F</kbd> {t`find`} · <kbd>⌘/</kbd> {t`comment`}</>}
      </span>
      <button
        type="button"
        className={`status-todos status-comments${openComments ? " has-todos" : ""}`}
        title={t`Editor comments`}
        onClick={props.onOpenComments}
      >
        <MessageSquareText size={12} />
        {openComments ? t({ message: `${{ count: openComments }} comments` }) : t`Comments`}
      </button>
      <button
        type="button"
        className={`status-todos status-manuscript-todos${todoCount ? " has-todos" : ""}`}
        title={t`Manuscript TODOs`}
        onClick={props.onOpenTodos}
      >
        <ListTodo size={12} />
        {todoCount ? t({ message: `${{ count: todoCount }} TODO` }) : t`TODOs`}
      </button>
      <span
        className="status-body-words"
        title={projectWordCount
          ? t({ message: `Body words (${{ source: projectWordCount.source === "texcount" ? "texcount" : t`estimate` }}): text ${{ text: projectWordCount.text }}, headers ${{ headers: projectWordCount.headers }}, captions ${{ captions: projectWordCount.captions }}` })
          : t`Body word count unavailable`}
      >
        {selectedText
          ? t({ message: `Sel ${{ words: selectionStats.words.toLocaleString() }} words · ${{ chars: selectionStats.chars.toLocaleString() }} chars · ${{ lines: selectionStats.lines.toLocaleString() }} lines` })
          : projectWordCount
            ? t({ message: `Body ${{ body: projectWordCount.total.toLocaleString() }} · raw ${{ raw: wordCount.toLocaleString() }} · ${{ chars: source.length.toLocaleString() }} chars` })
            : t({ message: `${{ words: wordCount.toLocaleString() }} words · ${{ chars: source.length.toLocaleString() }} chars` })}
      </span>
    </div>
  );
}
