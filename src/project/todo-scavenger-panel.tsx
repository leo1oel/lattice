import { FileText, ListTodo } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { ResearchArt } from "../components/ui/research-art";
import { NOTE_SPIKE } from "../components/ui/research-art-note-spike";
import { PanelHeader } from "../components/ui/panel-header";
import type { TodoHit } from "./todo-scavenger";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

/* The markers the scan matches, as the writer types them. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX syntax, not interface copy
const MARKERS = ["% TODO", "% FIXME", "% XXX", "\\todo"];

/** The kind as the writer typed it: a `\todo` command is not a comment marker. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX syntax, not interface copy
const kindLabel = (kind: string) => (kind === "todo" ? "\\todo" : kind);

/** Hits in the scan's order, gathered under the file they sit in. */
function byFile(hits: TodoHit[]) {
  const files = new Map<string, TodoHit[]>();
  for (const hit of hits) {
    const list = files.get(hit.path);
    if (list) list.push(hit);
    else files.set(hit.path, [hit]);
  }
  return [...files];
}

export function TodoScavengerPanel(props: {
  hits: TodoHit[];
  onClose: () => void;
  onOpen: (path: string, line: number) => void;
}) {
  const { t } = useLingui();
  const count = props.hits.length;
  const files = byFile(props.hits);
  return (
    <ResizableDrawer className="todo-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<ListTodo size={16} />}
          title={t`Manuscript TODOs`}
          onClose={props.onClose}
        />
        {/* What counts as a marker matters only while there are none. */}
        {count === 0 ? (
          <EmptyState
            className="todo-empty"
            fill
            icon={<ResearchArt drawing={NOTE_SPIKE} />}
            title={t`No TODO markers found`}
            description={t`Markers left in any source file of the project are listed here`}
            actions={(
              <ul className="todo-empty-markers">
                {MARKERS.map((marker) => <li key={marker}><code>{marker}</code></li>)}
              </ul>
            )}
          />
        ) : (
          <>
            <p className="todo-summary">
              {count === 1 ? t`${count} marker` : t`${count} markers`}
              {files.length > 1 && <span>{t`in ${files.length} files`}</span>}
            </p>
            <div className="todo-hits fluid-hover-surface">
              <FluidHoverSurface selector=".todo-hit" follow={null} />
              {files.map(([path, hits]) => (
                <section key={path} className="todo-file">
                  <h3 className="todo-file-head">
                    <FileText size={13} aria-hidden="true" />
                    <span className="todo-file-path" title={path}>{path}</span>
                    <span className="todo-file-count">{hits.length}</span>
                  </h3>
                  <ul className="todo-file-hits">
                    {hits.map((hit) => (
                      <li key={`${hit.line}:${hit.kind}:${hit.preview}`}>
                        <button
                          type="button"
                          className="todo-hit"
                          data-kind={hit.kind.toLowerCase()}
                          onClick={() => props.onOpen(hit.path, hit.line)}
                        >
                          <span className="todo-hit-kind">{kindLabel(hit.kind)}</span>
                          <span className="todo-hit-line">{t`Line ${hit.line}`}</span>
                          <span className="todo-hit-preview">{hit.preview}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
    </ResizableDrawer>
  );
}
