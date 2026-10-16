import { useMemo, useState, type ReactElement, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { Ellipsis, ListTodo, MessageSquareText } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";
import { countWords, textStats } from "../editor/latex/latex-edits";
import type { OutlineNode } from "../editor/latex/latex-outline";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { EditorKeymap, WordCount } from "../app-types";
import { formatCount } from "../i18n";
import { spaceMixedScript } from "../trellis/trellis-titles";
import { useLatestRef } from "../hooks/use-latest-ref";
import { StatusSaveState, type SaveSlot } from "./status-save-state";

const CARET_LINE = "\u0001";
const CARET_COLUMN = "\u0002";

/**
 * Caret position, save state, Vim mode, section breadcrumb, shortcuts,
 * comments/TODOs, and word counts for the focused editor.
 *
 * The bar never wraps or clips: as it narrows, app-shell.css's ladder gives
 * way in a fixed order (see the comment there), and whatever leaves the bar is
 * still one click away in the "More" popover at its end.
 */
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
  /** The save slot after the caret. */
  saveSlot?: SaveSlot;
}) {
  const { position, breadcrumb, todoCount } = props;
  const { t } = useLingui();
  const openComments = props.comments.filter((comment) => !comment.resolved).length;
  const column = position.column + 1;
  // The caret's words in the reader's language ("Ln ", ", Col "; "第 ", " 行，第 ",
  // " 列") around its two numbers, each its own node: a keystroke rewrites
  // only the column's text, and the narrowest step hides the words and
  // reads "61:2", as an editor gutter does.
  const caretWords = t({ message: `Ln ${{ line: CARET_LINE }}, Col ${{ column: CARET_COLUMN }}` })
    .split(new RegExp(`${CARET_LINE}|${CARET_COLUMN}`));
  const counters = useCounters(openComments, todoCount);
  const openCounter = { "status-comments": props.onOpenComments, "status-manuscript-todos": props.onOpenTodos };
  // More's props hold still as the writer types, so the keystrokes never
  // render it: it takes the counts rather than the counters, its openers
  // through a ref (App's are new each render), and the text it counts only
  // while it is open.
  const [moreOpen, setMoreOpen] = useState(false);
  const openersRef = useLatestRef<Openers>(openCounter);
  return (
    <div className="editor-status-bar" aria-label={t`Editor status`}>
      <button
        type="button"
        className="status-item status-goto"
        title={t`Go to line (⌘G)`}
        onClick={props.onGotoLine}
      >
        <span className="status-caret">
          {caretWords[0] && <span className="status-caret-word">{caretWords[0]}</span>}
          <span>{position.line}</span>
          {caretWords[1] && <span className="status-caret-word">{caretWords[1]}</span>}
          <span className="status-caret-column">{column}</span>
          {caretWords[2] && <span className="status-caret-word">{caretWords[2]}</span>}
        </span>
      </button>
      {props.saveSlot && <StatusSaveState slot={props.saveSlot} path={props.path} />}
      {props.keymap === "vim" && (
        <span className="status-vim-mode" aria-live="polite" title={t`Vim mode`}>
          <span className="status-vim-full">--{props.vimMode.toUpperCase()}--</span>
          {/* The mode's initial, as compact Vim status lines show it. */}
          <span className="status-vim-compact">{props.vimMode.charAt(0).toUpperCase()}</span>
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
      {/* Icon, noun and count, in that order at every width, so the number
          is always the last thing in the item and the eye finds it in one
          place: the noun goes first as the bar narrows, leaving the icon and
          the count. An open item puts its icon and count in the accent; none
          open shows no count. Inline rather than a component: the bar renders
          on every keystroke. */}
      {counters.map(({ className, icon, label, title, count, name }) => (
        <button
          key={className}
          type="button"
          className={`status-item status-counter ${className}`}
          data-active={count > 0 || undefined}
          title={title}
          aria-label={name}
          onClick={openCounter[className]}
        >
          {icon}
          <span className="status-label">{label}</span>
          {count > 0 && <span className="status-count">{formatCount(count)}</span>}
        </button>
      ))}
      <StatusWordCount
        projectWordCount={props.projectWordCount}
        path={props.path}
        selectedText={props.selectedText}
        source={props.source}
      />
      <StatusMore
        open={moreOpen}
        onOpenChange={setMoreOpen}
        openComments={openComments}
        todoCount={todoCount}
        openersRef={openersRef}
        projectWordCount={props.projectWordCount}
        path={props.path}
        selectedText={moreOpen ? props.selectedText : ""}
        source={moreOpen ? props.source : ""}
      />
    </div>
  );
}

type CounterClass = "status-comments" | "status-manuscript-todos";
type Openers = Record<CounterClass, () => void>;

type StatusCounter = {
  className: CounterClass;
  icon: ReactElement;
  /** The noun, shown beside the icon while the bar has room for it. */
  label: string;
  title: string;
  count: number;
  /** The count in words, the button's accessible name whatever is shown. */
  name: string;
};

/** The two counters' nouns and names, from their counts alone. */
function useCounters(openComments: number, todoCount: number): StatusCounter[] {
  const { t } = useLingui();
  return [
    {
      className: "status-comments",
      // Elements, not components: constant, so typing never renders them.
      icon: <MessageSquareText size={12} aria-hidden="true" />,
      label: t`Annotations`,
      title: t`Annotations`,
      count: openComments,
      name: !openComments
        ? t`Annotations`
        : openComments === 1
          ? t({ message: `${{ count: openComments }} annotation` })
          : t({ message: `${{ count: openComments }} annotations` }),
    },
    {
      className: "status-manuscript-todos",
      icon: <ListTodo size={12} aria-hidden="true" />,
      label: t`TODOs`,
      title: t`Manuscript TODOs`,
      count: todoCount,
      name: !todoCount
        ? t`TODOs`
        : todoCount === 1
          ? t({ message: `${{ count: todoCount }} TODO` })
          : t({ message: `${{ count: todoCount }} TODOs` }),
    },
  ];
}

type WordCountSource = {
  projectWordCount: WordCount | null;
  path: string;
  selectedText: string;
  source: string;
};

type WordCountLabels = ReturnType<typeof useWordCountLabels>;

/**
 * The footer names the scope of the one count it shows: the selection while
 * there is one, else the manuscript, else this file. The details lay every
 * count out by scope. The manuscript count is the backend's, refreshed on
 * save; only the cheap local counts follow the settled buffer.
 */
function useWordCountLabels(props: WordCountSource) {
  const { projectWordCount, selectedText, source } = props;
  const { t } = useLingui();
  const fileWords = useMemo(() => countWords(source), [source]);
  const selection = useMemo(() => textStats(selectedText), [selectedText]);
  const estimated = projectWordCount != null && projectWordCount.source !== "texcount";
  // A count over 10,000 reads in 万 in Chinese ("12.04 万词"); see formatCount.
  const words = (count: number) => spaceMixedScript(count === 1
    ? t({ message: `${{ count: formatCount(count) }} word` })
    : t({ message: `${{ count: formatCount(count) }} words` }));
  // An estimate reads as one in the footer too, not only in the details.
  const manuscriptWords = (count: number) => (estimated ? `≈${words(count)}` : words(count));
  const characters = (count: number) => spaceMixedScript(count === 1
    ? t({ message: `${{ count: formatCount(count) }} character` })
    : t({ message: `${{ count: formatCount(count) }} characters` }));
  const lines = (count: number) => spaceMixedScript(count === 1
    ? t({ message: `${{ count: formatCount(count) }} line` })
    : t({ message: `${{ count: formatCount(count) }} lines` }));
  const [scope, count] = selectedText
    ? [t`Selection`, words(selection.words)]
    : projectWordCount
      ? [t`Manuscript`, manuscriptWords(projectWordCount.total)]
      : [t`This file`, words(fileWords)];
  const fileName = props.path.slice(props.path.lastIndexOf("/") + 1);
  return {
    scope,
    count,
    manuscript: projectWordCount ? manuscriptWords(projectWordCount.total) : null,
    manuscriptNote: !projectWordCount
      ? t`Needs a root document to count from`
      : estimated
        ? t`Root document only, estimated without texcount`
        : t`Root document and its includes, via texcount`,
    manuscriptBreakdown: projectWordCount && !estimated
      ? spaceMixedScript(t({ message: `Text ${{ text: formatCount(projectWordCount.text) }} · headings ${{ headers: formatCount(projectWordCount.headers) }} · captions ${{ captions: formatCount(projectWordCount.captions) }}` }))
      : null,
    file: words(fileWords),
    fileNote: t({ message: `${{ fileName }}, markup included · ${{ characters: characters(source.length) }}` }),
    selection: selectedText ? words(selection.words) : null,
    selectionNote: `${characters(selection.chars)} · ${lines(selection.lines)}`,
  };
}

function StatusWordCount(props: WordCountSource) {
  const { t } = useLingui();
  const words = useWordCountLabels(props);
  const { scope, count } = words;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="status-item status-body-words"
          title={t`Word count`}
          aria-label={t`Word count: ${scope}, ${count}`}
        >
          <span className="status-word-scope">{scope}</span>
          <span className="status-word-count">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="word-count-popover" aria-label={t`Word count`}>
        <WordCountDetails words={words} />
      </PopoverContent>
    </Popover>
  );
}

function WordCountDetails({ words }: { words: WordCountLabels }) {
  const { t } = useLingui();
  return (
    <dl>
      <div>
        <dt>{t`Manuscript`}</dt>
        <dd>{words.manuscript ?? t`Unavailable`}</dd>
        <dd className="word-count-note">{words.manuscriptNote}</dd>
        {words.manuscriptBreakdown && <dd className="word-count-note">{words.manuscriptBreakdown}</dd>}
      </div>
      <div>
        <dt>{t`This file`}</dt>
        <dd>{words.file}</dd>
        <dd className="word-count-note">{words.fileNote}</dd>
      </div>
      {words.selection && (
        <div>
          <dt>{t`Selection`}</dt>
          <dd>{words.selection}</dd>
          <dd className="word-count-note">{words.selectionNote}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The bar's last item once it is too narrow for the word count: everything
 * the ladder can take away (the counters and every word count) in one
 * popover, so no item is ever out of reach. Hidden while the word count shows.
 */
function StatusMore({ open, onOpenChange, openComments, todoCount, openersRef, ...source }: WordCountSource & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openComments: number;
  todoCount: number;
  openersRef: RefObject<Openers>;
}) {
  const { t } = useLingui();
  const counters = useCounters(openComments, todoCount);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="status-item status-more" title={t`More editor status`} aria-label={t`More editor status`}>
          <Ellipsis size={12} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="word-count-popover status-more-popover" aria-label={t`Editor status`}>
        <div className="status-more-rows fluid-hover-surface">
          <FluidHoverSurface selector=".status-more-row" follow=":focus" />
          {counters.map(({ className, icon, label, count, name }) => (
            <button
              key={className}
              type="button"
              className="status-more-row"
              data-active={count > 0 || undefined}
              aria-label={name}
              // Choosing a row closes More first, as a menu does, so focus
              // goes back to its trigger before the drawer opens.
              onClick={() => {
                onOpenChange(false);
                openersRef.current[className]();
              }}
            >
              {icon}
              <span>{label}</span>
              {count > 0 && <span className="status-count">{formatCount(count)}</span>}
            </button>
          ))}
        </div>
        <StatusMoreWordCount {...source} />
      </PopoverContent>
    </Popover>
  );
}

/** More's word counts: mounted only while it is open, so they are counted only then. */
function StatusMoreWordCount(props: WordCountSource) {
  return <WordCountDetails words={useWordCountLabels(props)} />;
}
