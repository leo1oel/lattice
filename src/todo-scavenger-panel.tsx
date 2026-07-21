import { CircleDot, ListTodo, X } from "lucide-react";
import type { TodoHit } from "./todo-scavenger";

export function TodoScavengerPanel(props: {
  hits: TodoHit[];
  onClose: () => void;
  onOpen: (path: string, line: number) => void;
}) {
  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer todo-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><ListTodo size={16} /><span>Manuscript TODOs</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
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
      </aside>
    </div>
  );
}
