import { ListTree } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Tip } from "./components/icon-tip";
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
            <span>{node.title}</span>
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
  return (
    <Popover open={props.open} onOpenChange={(open) => open ? props.onOpen() : props.onClose()}>
      <Tip label="Show outline">
        <PopoverTrigger asChild>
          <button type="button" className="pdf-outline-trigger" aria-label="Show document outline" title="Show outline">
            <ListTree size={14} />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" sideOffset={7} className="document-outline-popover" aria-label="Document outline">
        <div className="document-outline-header"><ListTree size={13} /><span>Outline</span></div>
        {props.nodes.length
          ? <OutlineBranch nodes={props.nodes} activeId={props.activeId ?? null} onSelect={props.onSelect} />
          : <p className="document-outline-empty">No sections yet. Add a {"\\section{…}"} to start the outline.</p>}
      </PopoverContent>
    </Popover>
  );
}
