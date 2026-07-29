import { CircleDot, ListTodo } from "lucide-react";
import { PanelHeader } from "./components/ui/panel-header";
import type { TodoHit } from "./todo-scavenger";
import { ResizableDrawer } from "./resizable-drawer";

export function TodoScavengerPanel(props: {
  hits: TodoHit[];
  onClose: () => void;
  onOpen: (path: string, line: number) => void;
}) {
  return (
    <ResizableDrawer className="todo-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<ListTodo size={16} />}
          title="Manuscript TODOs"
          onClose={props.onClose}
        />
        <p className="drawer-copy">
          Scans `.tex` / `.md` for `% TODO`, `% FIXME`, `% XXX`, and `\todo`.
          Click a hit to jump; the active unsaved buffer is included.
        </p>
        <div className="project-replace-preview-summary">
          {props.hits.length
            ? `${props.hits.length} marker${props.hits.length === 1 ? "" : "s"}`
            : "No TODO markers found."}
        </div>
        <ul className="project-replace-hits todo-hits">
          {props.hits.map((hit) => (
            <li key={`${hit.path}:${hit.line}:${hit.kind}:${hit.preview}`}>
              <button
                type="button"
                className="project-replace-hit"
                onClick={() => props.onOpen(hit.path, hit.line)}
              >
                <span className="project-replace-hit-path">
                  <CircleDot size={10} className={`todo-kind ${hit.kind.toLowerCase()}`} />
                  {hit.kind} · {hit.path}:{hit.line}
                </span>
                <span className="project-replace-hit-preview">{hit.preview}</span>
              </button>
            </li>
          ))}
        </ul>
    </ResizableDrawer>
  );
}
