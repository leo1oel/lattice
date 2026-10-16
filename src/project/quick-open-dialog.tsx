import { useMemo, useRef, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Hash, TextCursorInput } from "lucide-react";
import { rankMatches, scoreItem, scorePath } from "../components/ui/picker-ranking";
import { PickerDialog, type SearchPickerItem } from "../components/ui/search-picker-dialog";
import { renderKeycaps } from "../components/ui/render-keycaps";
import { comboKeys } from "../app/key-combos";
import { isProjectAssetFilePath } from "../app-utils";
import { fileIcon } from "../trellis/trellis-icons";

/*
 * Quick open (⌘P). An empty query lists the files visited this session first,
 * newest first and without the one on screen, so ⌘P ↩ goes back to the
 * previous file; every other file follows. A typed query ranks every file,
 * recent ones a little higher. Two prefixes reach the other pickers' targets
 * from here, as GitLab and VS Code do: `@` lists sections and labels (Go to
 * symbol's items) and `:42` goes to a line of the file on screen; a path query
 * ending in `:42` opens that file at the line. The footer names both.
 */

type Row =
  | { kind: "file"; id: string; path: string; group?: string; line?: number; current?: boolean }
  | { kind: "symbol"; id: string; item: SearchPickerItem; group?: string }
  | { kind: "line"; id: string; line: number };

/** How many visited files an empty query lists before the rest. */
const RECENT_SHOWN = 6;
/** What each step up the recent list adds to a typed match's score. */
const RECENCY_BOOST = 12;
const RESULT_LIMIT = 40;

/** `name:42`: a path query that opens at a line. */
const PATH_WITH_LINE = /^(.+?):(\d+)$/;
/** `:42`: a line of the file on screen. */
const LINE_ONLY = /^:(\d+)$/;

/** The part of the query a row's text was matched against, without its prefix or line. */
function matchedQuery(query: string) {
  if (query.startsWith("@")) return query.slice(1).trim();
  return (PATH_WITH_LINE.exec(query)?.[1] ?? query).trim();
}

/**
 * The query's characters in `text`, marked: a run of them where there is one,
 * else each in order, the way the ranking found them. A query the text does
 * not hold in order (it matched the folder) marks nothing.
 */
function markMatch(text: string, query: string): ReactNode {
  const needle = query.replace(/\s+/g, "").toLocaleLowerCase();
  if (!needle) return text;
  const hay = text.toLocaleLowerCase();
  const hits = new Set<number>();
  const run = hay.indexOf(needle);
  if (run >= 0) {
    for (let index = 0; index < needle.length; index += 1) hits.add(run + index);
  } else {
    let from = 0;
    for (const character of needle) {
      const at = hay.indexOf(character, from);
      if (at < 0) return text;
      hits.add(at);
      from = at + 1;
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index < text.length && hits.has(index) === hits.has(start)) continue;
    const piece = text.slice(start, index);
    parts.push(hits.has(start) ? <mark key={start} className="picker-match">{piece}</mark> : piece);
    start = index;
  }
  return parts;
}

/** The file's name first, where the eye looks, and its folder after it, quieter; a line or tag at the end. */
function PathRow({ path, query, line, tag }: { path: string; query: string; line?: number; tag?: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="picker-file">
      <span className="picker-file-icon">{fileIcon(path, isProjectAssetFilePath(path) ? "asset" : "file")}</span>
      <span className="picker-file-name">{markMatch(path.slice(slash + 1), query)}</span>
      {slash > 0 && <span className="picker-file-folder">{path.slice(0, slash)}</span>}
      {line ? <span className="picker-file-tag">:{line}</span> : tag ? <span className="picker-file-tag">{tag}</span> : null}
    </span>
  );
}

type QuickOpenProps = {
  paths: string[];
  /** The files visited this session, newest first. */
  recent: string[];
  /** The file on screen, tagged in the list and the target of `:42`. */
  current: string;
  /** Go to symbol's sections and labels, read the first time `@` is typed. */
  symbols: () => SearchPickerItem[];
  onClose: () => void;
  onOpen: (path: string, line?: number) => void;
  onSymbol: (item: SearchPickerItem) => void;
  onLine: (line: number) => void;
  onIntent?: (path: string) => void;
};

/** Unmounting the form while closed resets its query and highlight. */
export function QuickOpenDialog({ open, ...props }: QuickOpenProps & { open: boolean }) {
  return open ? <QuickOpenDialogForm {...props} /> : null;
}

function QuickOpenDialogForm({ paths, recent, current, symbols, onOpen, onSymbol, onLine, onIntent, ...props }: QuickOpenProps) {
  const { t } = useLingui();
  const symbolsRef = useRef<SearchPickerItem[] | null>(null);
  const rank = useMemo(() => {
    const present = new Set(paths);
    const recentShown = recent.filter((path) => path !== current && present.has(path)).slice(0, RECENT_SHOWN);
    const recency = new Map(recentShown.map((path, index) => [path, RECENT_SHOWN - index]));
    return (query: string): Row[] => {
      if (query.startsWith("@")) {
        // Read the first time `@` is typed, then kept for this opening.
        if (!symbolsRef.current) symbolsRef.current = symbols();
        const needle = matchedQuery(query);
        return rankMatches(symbolsRef.current, (item) => scoreItem(item, needle), () => 0, RESULT_LIMIT)
          .map((item): Row => ({ kind: "symbol", id: item.id, item, group: item.group }));
      }
      const lineOnly = LINE_ONLY.exec(query);
      if (lineOnly) return [{ kind: "line", id: "line", line: Number(lineOnly[1]) }];
      if (!query) {
        const rest = paths.filter((path) => !recency.has(path)).sort((left, right) => left.localeCompare(right)).slice(0, RESULT_LIMIT);
        return [
          ...recentShown.map((path): Row => ({ kind: "file", id: `recent:${path}`, path, group: t`Recent` })),
          ...rest.map((path): Row => ({ kind: "file", id: path, path, group: t`All files`, current: path === current })),
        ];
      }
      const withLine = PATH_WITH_LINE.exec(query);
      const needle = matchedQuery(query);
      const line = withLine ? Number(withLine[2]) : undefined;
      return rankMatches(
        paths,
        (path) => {
          const score = scorePath(path, needle);
          return score > 0 ? score + (recency.get(path) ?? 0) * RECENCY_BOOST : 0;
        },
        (left, right) => left.localeCompare(right),
        RESULT_LIMIT,
      ).map((path): Row => ({ kind: "file", id: path, path, line, current: path === current }));
    };
  }, [current, paths, recent, symbols, t]);
  return (
    <PickerDialog<Row>
      {...props}
      label={t`Quick open file`}
      searchLabel={t`Quick open search`}
      placeholder={t`Open file…`}
      emptyText={t`No matching files`}
      rank={rank}
      itemKey={(row) => row.id}
      itemLabel={(row) => (row.kind === "file" ? row.path : row.kind === "symbol" ? row.item.label : undefined)}
      groupOf={(row) => (row.kind === "line" ? undefined : row.group)}
      renderItem={(row, query) => {
        if (row.kind === "file") return <PathRow path={row.path} query={matchedQuery(query)} line={row.line} tag={row.current ? t`Current` : undefined} />;
        if (row.kind === "line") {
          return (
            <span className="picker-file">
              <span className="picker-file-icon"><TextCursorInput size={14} aria-hidden="true" /></span>
              <span className="picker-file-name">{t`Go to line ${row.line}`}</span>
              <span className="picker-file-folder">{current}</span>
            </span>
          );
        }
        return (
          <span className="picker-file">
            <span className="picker-file-icon"><Hash size={14} aria-hidden="true" /></span>
            <span className="picker-file-name">{markMatch(row.item.label, matchedQuery(query))}</span>
            {row.item.detail && <span className="picker-file-folder">{row.item.detail}</span>}
          </span>
        );
      }}
      onIntent={onIntent ? (row) => { if (row.kind === "file") onIntent(row.path); } : undefined}
      onSelect={(row) => {
        if (row.kind === "file") onOpen(row.path, row.line);
        else if (row.kind === "symbol") onSymbol(row.item);
        else onLine(row.line);
      }}
      footer={(
        <div className="command-palette-footer quick-open-footer" aria-hidden="true">
          <span className="quick-open-scopes">
            <span>{renderKeycaps(["@"])}{t`Sections and labels`}</span>
            <span>{renderKeycaps([":"])}{t`Line`}</span>
          </span>
          <span>{renderKeycaps([...comboKeys({ key: "ArrowUp" }), ...comboKeys({ key: "ArrowDown" })])}{t`Move`}</span>
          <span>{renderKeycaps(comboKeys({ key: "Enter" }))}{t`Open`}</span>
        </div>
      )}
    />
  );
}
