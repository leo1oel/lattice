import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { ListTodo, MessageSquareText } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
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
  /** The open file; a breadcrumb entry without a path of its own belongs to it. */
  path: string;
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
  const { position, breadcrumb, todoCount } = props;
  const { t } = useLingui();
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
                onClick={() => props.onNavigate(node.path || props.path, node.line)}
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
        {!openComments
          ? t`Comments`
          : openComments === 1
            ? t({ message: `${{ count: openComments }} comment` })
            : t({ message: `${{ count: openComments }} comments` })}
      </button>
      <button
        type="button"
        className={`status-todos status-manuscript-todos${todoCount ? " has-todos" : ""}`}
        title={t`Manuscript TODOs`}
        onClick={props.onOpenTodos}
      >
        <ListTodo size={12} />
        {!todoCount
          ? t`TODOs`
          : todoCount === 1
            ? t({ message: `${{ count: todoCount }} TODO` })
            : t({ message: `${{ count: todoCount }} TODOs` })}
      </button>
      <StatusWordCount
        projectWordCount={props.projectWordCount}
        path={props.path}
        selectedText={props.selectedText}
        source={props.source}
      />
    </div>
  );
}

/**
 * The footer names the scope of the one count it shows: the selection while
 * there is one, else the manuscript, else this file. The popover lays every
 * count out by scope. The manuscript count is the backend's, refreshed on
 * save; only the cheap local counts follow the settled buffer.
 */
function StatusWordCount(props: {
  projectWordCount: WordCount | null;
  path: string;
  selectedText: string;
  source: string;
}) {
  const { projectWordCount, selectedText, source } = props;
  const { t } = useLingui();
  const fileWords = useMemo(() => countWords(source), [source]);
  const selection = useMemo(() => textStats(selectedText), [selectedText]);
  const estimated = projectWordCount != null && projectWordCount.source !== "texcount";
  const words = (count: number) => (count === 1
    ? t({ message: `${{ count: count.toLocaleString() }} word` })
    : t({ message: `${{ count: count.toLocaleString() }} words` }));
  // An estimate reads as one in the footer too, not only in the details.
  const manuscriptWords = (count: number) => (estimated ? `≈${words(count)}` : words(count));
  const characters = (count: number) => (count === 1
    ? t({ message: `${{ count: count.toLocaleString() }} character` })
    : t({ message: `${{ count: count.toLocaleString() }} characters` }));
  const lines = (count: number) => (count === 1
    ? t({ message: `${{ count: count.toLocaleString() }} line` })
    : t({ message: `${{ count: count.toLocaleString() }} lines` }));
  const [scope, count] = selectedText
    ? [t`Selection`, words(selection.words)]
    : projectWordCount
      ? [t`Manuscript`, manuscriptWords(projectWordCount.total)]
      : [t`This file`, words(fileWords)];
  const fileName = props.path.slice(props.path.lastIndexOf("/") + 1);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="status-body-words" aria-label={t`Word count: ${scope}, ${count}`}>
          <span className="status-word-scope">{scope}</span>
          <span>{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="word-count-popover" aria-label={t`Word count`}>
        <dl>
          <div>
            <dt>{t`Manuscript`}</dt>
            <dd>{projectWordCount ? manuscriptWords(projectWordCount.total) : t`Unavailable`}</dd>
            <dd className="word-count-note">
              {!projectWordCount
                ? t`Needs a root document to count from`
                : estimated
                  ? t`Root document only, estimated without texcount`
                  : t`Root document and its includes, via texcount`}
            </dd>
            {projectWordCount && !estimated && (
              <dd className="word-count-note">
                {t({ message: `Text ${{ text: projectWordCount.text.toLocaleString() }} · headings ${{ headers: projectWordCount.headers.toLocaleString() }} · captions ${{ captions: projectWordCount.captions.toLocaleString() }}` })}
              </dd>
            )}
          </div>
          <div>
            <dt>{t`This file`}</dt>
            <dd>{words(fileWords)}</dd>
            <dd className="word-count-note">{t({ message: `${{ fileName }}, markup included · ${{ characters: characters(source.length) }}` })}</dd>
          </div>
          {selectedText && (
            <div>
              <dt>{t`Selection`}</dt>
              <dd>{words(selection.words)}</dd>
              <dd className="word-count-note">{`${characters(selection.chars)} · ${lines(selection.lines)}`}</dd>
            </div>
          )}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
