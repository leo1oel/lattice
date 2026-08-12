import { useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Omega } from "lucide-react";
import { EmptyState } from "./components/ui/empty-state";
import { PanelHeader } from "./components/ui/panel-header";
import { ScrollArea } from "./components/ui/scroll-area";
import { SearchField } from "./components/ui/search-field";
import { INSERT_GROUPS, INSERT_SNIPPETS, type InsertSnippet } from "./insert-snippets";
import { SlidingTabs } from "./motion";
import { ResizableDrawer } from "./resizable-drawer";

function snippetPreview(snippet: InsertSnippet): { kind: "html" | "glyph" | "code"; value: string } {
  if (snippet.mathPreview) {
    try {
      return {
        kind: "html",
        value: katex.renderToString(snippet.mathPreview, {
          throwOnError: false,
          strict: "ignore",
          displayMode: false,
        }),
      };
    } catch {
      // Fall through to glyph / code.
    }
  }
  if (snippet.glyph) return { kind: "glyph", value: snippet.glyph };
  if (snippet.codePreview) return { kind: "code", value: snippet.codePreview };
  return { kind: "code", value: snippet.insert.trim().slice(0, 80) };
}

function SnippetButton(props: {
  snippet: InsertSnippet;
  onInsert: (snippet: InsertSnippet) => void;
}) {
  const preview = useMemo(() => snippetPreview(props.snippet), [props.snippet]);
  return (
    <button
      type="button"
      className="insert-snippet-button"
      onClick={() => props.onInsert(props.snippet)}
      title={`${props.snippet.detail} · inserts ${props.snippet.insert.trim().split("\n")[0]}`}
    >
      <div className={`insert-snippet-preview ${preview.kind}`} aria-hidden="true">
        {preview.kind === "html"
          ? <span dangerouslySetInnerHTML={{ __html: preview.value }} />
          : preview.kind === "glyph"
            ? <span className="insert-snippet-glyph">{preview.value}</span>
            : <pre>{preview.value}</pre>}
      </div>
      <div className="insert-snippet-copy">
        <strong>{props.snippet.label}</strong>
        <span>{props.snippet.detail}</span>
        <code>{props.snippet.insert.trim().split("\n")[0]}</code>
      </div>
    </button>
  );
}

export function InsertPalette(props: {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: InsertSnippet) => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<(typeof INSERT_GROUPS)[number] | "All">("All");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return INSERT_SNIPPETS.filter((snippet) => {
      if (group !== "All" && snippet.group !== group) return false;
      if (!needle) return true;
      return (
        snippet.label.toLocaleLowerCase().includes(needle)
        || snippet.detail.toLocaleLowerCase().includes(needle)
        || snippet.insert.toLocaleLowerCase().includes(needle)
        || snippet.glyph?.toLocaleLowerCase().includes(needle)
      );
    });
  }, [group, query]);

  if (!props.open) return null;
  return (
    <ResizableDrawer
      className="insert-palette"
      ariaLabel="Insert LaTeX snippets"
      onClose={props.onClose}
    >
      <PanelHeader
        className="drawer-header"
        icon={<Omega size={16} />}
        title="Insert"
        closeLabel="Close insert palette"
        onClose={props.onClose}
      />
      <ScrollArea
        className="insert-palette-scroll"
        contentClassName="insert-palette-scroll-content"
        fadeEdges={false}
      >
        <SearchField
          autoFocus
          aria-label="Filter snippets"
          containerClassName="insert-palette-search"
          placeholder="Search by name, meaning, or command (alpha, implies, fraction…)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
        />
        <SlidingTabs
          value={group}
          onChange={(next) => setGroup(next as (typeof INSERT_GROUPS)[number] | "All")}
          ariaLabel="Insert categories"
          variant="none"
          className="insert-palette-tabs"
          tabClassName="insert-palette-tab ui-compact-selectable"
          items={[
            { value: "All", label: "All" },
            ...INSERT_GROUPS.map((name) => ({ value: name, label: name })),
          ]}
        />
        <div className="insert-palette-groups">
          {(group === "All" ? INSERT_GROUPS : [group]).map((name) => {
            const items = filtered.filter((snippet) => snippet.group === name);
            if (!items.length) return null;
            return (
              <section key={name}>
                <h3>{name}<small>{items.length}</small></h3>
                <div className="insert-palette-grid">
                  {items.map((snippet) => (
                    <SnippetButton
                      key={snippet.id}
                      snippet={snippet}
                      onInsert={(next) => {
                        props.onInsert(next);
                        props.onClose();
                      }}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {!filtered.length && (
            <EmptyState description="No matching snippets. Try fraction, implies, align*, or eqref." />
          )}
        </div>
      </ScrollArea>
    </ResizableDrawer>
  );
}
