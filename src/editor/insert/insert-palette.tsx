import { useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Omega } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import type { I18n } from "@lingui/core";
import { EmptyState } from "../../components/ui/empty-state";
import { PanelHeader } from "../../components/ui/panel-header";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SearchField } from "../../components/ui/search-field";
import { INSERT_GROUPS, INSERT_SNIPPETS, INSERT_SYMBOL_GROUPS, type InsertGroup, type InsertSnippet } from "./insert-snippets";
import { SlidingTabs } from "../../components/ui/motion";
import { ResizableDrawer } from "../../components/ui/resizable-drawer";

type Preview = { kind: "html" | "glyph" | "code"; value: string };

/**
 * KaTeX rendering is the palette's only expensive step, and the catalog is
 * static, so a render survives closing the drawer, changing tabs and typing in
 * the filter. Symbol groups never reach this path — they draw their Unicode
 * glyph, which is why scrolling the whole catalog stays cheap.
 */
const previewCache = new Map<string, Preview>();

function snippetPreview(snippet: InsertSnippet): Preview {
  const cached = previewCache.get(snippet.id);
  if (cached) return cached;
  const preview = ((): Preview => {
    if (snippet.mathPreview) {
      try {
        const value = katex.renderToString(snippet.mathPreview, { throwOnError: false, strict: "ignore", displayMode: false });
        return { kind: "html", value };
      } catch {
        // Fall through to glyph / code.
      }
    }
    if (snippet.glyph) return { kind: "glyph", value: snippet.glyph };
    return { kind: "code", value: snippet.codePreview ?? snippet.insert.trim().slice(0, 80) };
  })();
  previewCache.set(snippet.id, preview);
  return preview;
}

function snippetName(i18n: I18n, snippet: InsertSnippet): string {
  return typeof snippet.label === "string" ? snippet.label : i18n._(snippet.label);
}

/** Tabs, not groups: the eight symbol groups share one tab and stay as sections. */
/* eslint-disable lingui/no-unlocalized-strings -- tab and group keys; useGroupLabels translates them */
const INSERT_TABS = ["All", "Environment", "Structure", "Math", "Symbols"] as const;
type InsertTab = (typeof INSERT_TABS)[number];

const TAB_GROUPS: Record<InsertTab, readonly InsertGroup[]> = {
  All: INSERT_GROUPS,
  Environment: ["Environment"],
  Structure: ["Structure"],
  Math: ["Math"],
  Symbols: INSERT_SYMBOL_GROUPS,
};
/* eslint-enable lingui/no-unlocalized-strings */

const IS_SYMBOL_GROUP = new Set<InsertGroup>(INSERT_SYMBOL_GROUPS);

/**
 * Tab and heading names for the snippet catalog. The catalog itself is LaTeX
 * reference data keyed by these exact strings, so the translation lives here
 * rather than in `insert-snippets.ts` where the key would move with it.
 */
function useGroupLabels(): Record<InsertGroup | InsertTab, string> {
  const { t } = useLingui();
  return {
    All: t`All`, Symbols: t`Symbols`, Environment: t`Environment`, Structure: t`Structure`, Math: t`Math`,
    Greek: t`Greek`, Operators: t`Operators`, Relations: t`Relations`, Arrows: t`Arrows`, Sets: t`Sets`,
    Delimiters: t`Delimiters`, Accents: t`Accents`,
  };
}

function SnippetTile({ snippet, symbol, name, detail, onInsert }: {
  snippet: InsertSnippet;
  symbol: boolean;
  name: string;
  detail: string;
  onInsert: (snippet: InsertSnippet) => void;
}) {
  if (symbol) {
    return (
      <button
        type="button"
        className="insert-symbol-chip"
        onClick={() => onInsert(snippet)}
        title={`${detail}\n${name}`}
        aria-label={`${detail} (${name})`}
      >
        <span aria-hidden="true">{snippet.glyph ?? name}</span>
      </button>
    );
  }
  const preview = snippetPreview(snippet);
  const command = snippet.insert.trim().split("\n")[0];
  return (
    <button
      type="button"
      className="insert-snippet-button"
      onClick={() => onInsert(snippet)}
      title={`${detail}\n${command}`}
    >
      <div className={`insert-snippet-preview ${preview.kind}`} aria-hidden="true">
        {preview.kind === "html"
          ? <span dangerouslySetInnerHTML={{ __html: preview.value }} />
          : preview.kind === "glyph"
            ? <span className="insert-snippet-glyph">{preview.value}</span>
            : <pre>{preview.value}</pre>}
      </div>
      <div className="insert-snippet-copy">
        <strong>{name}</strong>
        <span>{detail}</span>
        {/* A code preview already shows the command; repeating it here was the
            palette's densest piece of noise. */}
        {preview.kind !== "code" && <code>{command}</code>}
      </div>
    </button>
  );
}

export function InsertPalette(props: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: InsertSnippet) => void;
}) {
  const { i18n, t } = useLingui();
  const groupLabels = useGroupLabels();
  const [query, setQuery] = useState("");
  // eslint-disable-next-line lingui/no-unlocalized-strings -- tab key; useGroupLabels translates it
  const [tab, setTab] = useState<InsertTab>("All");
  const locale = i18n.locale;

  // One haystack per snippet, rebuilt only when the interface language changes,
  // so a filter keystroke never resolves 300 catalog messages again.
  const haystacks = useMemo(() => new Map(INSERT_SNIPPETS.map((snippet) => [
    snippet.id,
    [snippetName(i18n, snippet), i18n._(snippet.detail), snippet.insert, snippet.glyph ?? ""]
      .join("\u0000")
      .toLocaleLowerCase(locale),
  ])), [i18n, locale]);

  const sections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return TAB_GROUPS[tab]
      .map((group) => ({
        group,
        items: INSERT_SNIPPETS.filter((snippet) => (
          snippet.group === group
          && (!needle || (haystacks.get(snippet.id) ?? "").includes(needle))
        )),
      }))
      .filter((section) => section.items.length > 0);
  }, [haystacks, locale, query, tab]);

  if (!props.open) return null;
  const insertAndClose = (snippet: InsertSnippet) => {
    props.onInsert(snippet);
    props.onClose();
  };
  return (
    <ResizableDrawer
      className="insert-palette"
      ariaLabel={t`Insert LaTeX snippets`}
      onClose={props.onClose}
    >
      <PanelHeader
        className="drawer-header"
        icon={<Omega size={16} />}
        title={t`Insert`}
        closeLabel={t`Close insert palette`}
        onClose={props.onClose}
      />
      <ScrollArea
        className="insert-palette-scroll"
        contentClassName="insert-palette-scroll-content"
        fadeEdges={false}
      >
        <SearchField
          autoFocus
          aria-label={t`Filter snippets`}
          containerClassName="insert-palette-search"
          placeholder={t`Search by name, meaning, or command (alpha, implies, fraction…)`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
        />
        <SlidingTabs
          value={tab}
          onChange={(next) => setTab(next as InsertTab)}
          ariaLabel={t`Insert categories`}
          variant="none"
          className="insert-palette-tabs"
          tabClassName="insert-palette-tab ui-compact-selectable"
          items={INSERT_TABS.map((name) => ({ value: name, label: groupLabels[name] }))}
        />
        <div className="insert-palette-groups">
          {sections.map(({ group, items }) => (
            <section key={group}>
              <h3>{groupLabels[group]}<small>{items.length}</small></h3>
              <div className={IS_SYMBOL_GROUP.has(group) ? "insert-symbol-grid" : "insert-palette-grid"}>
                {items.map((snippet) => (
                  <SnippetTile
                    key={snippet.id}
                    snippet={snippet}
                    symbol={IS_SYMBOL_GROUP.has(group)}
                    name={snippetName(i18n, snippet)}
                    detail={i18n._(snippet.detail)}
                    onInsert={insertAndClose}
                  />
                ))}
              </div>
            </section>
          ))}
          {!sections.length && (
            <EmptyState description={t`No matching snippets. Try fraction, implies, align*, or eqref`} />
          )}
        </div>
      </ScrollArea>
    </ResizableDrawer>
  );
}
