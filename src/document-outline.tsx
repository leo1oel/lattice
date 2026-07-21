import { ChevronLeft, ListTree } from "lucide-react";
import type { OutlineNode } from "./latex-outline";

function OutlineBranch({
  nodes,
  activeId,
  onSelect,
}: {
  nodes: OutlineNode[];
  activeId: string | null;
  onSelect: (path: string, line: number) => void;
}) {
  return (
    <ul className="document-outline-list">
      {nodes.map((node) => (
        <li key={node.id} data-level={node.level} data-kind={node.kind ?? "section"}>
          <button
            type="button"
            className={node.id === activeId ? "active" : ""}
            onClick={() => onSelect(node.path || "", node.line)}
            title={node.path ? `${node.path}:${node.line}` : `Go to line ${node.line}`}
          >
            <span>{node.kind === "input" ? `\\input{${node.title}}` : node.title}</span>
            <small>{node.line}</small>
          </button>
          {node.children.length > 0 && (
            <OutlineBranch nodes={node.children} activeId={activeId} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function DocumentOutline(props: {
  nodes: OutlineNode[];
  activeId?: string | null;
  open: boolean;
  onSelect: (path: string, line: number) => void;
  onClose: () => void;
  onOpen: () => void;
  available: boolean;
}) {
  if (!props.available) return null;
  if (!props.open) {
    return (
      <div className="document-outline-rail" aria-label="Show document outline">
        <button type="button" title="Show outline" onClick={props.onOpen}>
          <ListTree size={13} />
          <span>Outline</span>
        </button>
      </div>
    );
  }
  return (
    <aside className="document-outline" aria-label="Document outline">
      <div className="document-outline-header">
        <div>
          <ListTree size={13} />
          <span>Outline</span>
        </div>
        <button type="button" className="document-outline-close" title="Hide outline" onClick={props.onClose}>
          <ChevronLeft size={14} />
          <span>Hide</span>
        </button>
      </div>
      {props.nodes.length
        ? (
          <OutlineBranch
            nodes={props.nodes}
            activeId={props.activeId ?? null}
            onSelect={props.onSelect}
          />
        )
        : <p className="document-outline-empty">No sections yet. Add a {"\\section{…}"} to start the outline.</p>}
    </aside>
  );
}
