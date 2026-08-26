import { ListTree } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tip } from "../components/icon-tip";
import type { OutlineNode } from "../editor/latex/latex-outline";

function OutlineBranch({
  nodes,
  activeId,
  onSelect,
}: {
  nodes: OutlineNode[];
  activeId: string | null;
  onSelect: (path: string, line: number) => void;
}) {
  const { t } = useLingui();
  return (
    <ul className="document-outline-list">
      {nodes.map((node) => (
        <li key={node.id} data-level={node.level} data-kind={node.kind ?? "section"}>
          <button
            type="button"
            className={node.id === activeId ? "active" : ""}
            onClick={() => onSelect(node.path || "", node.line)}
            title={node.path ? `${node.path}:${node.line}` : t`Go to line ${node.line}`}
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
  const { t } = useLingui();
  if (!props.available) return null;
  return (
    <Popover open={props.open} onOpenChange={(open) => open ? props.onOpen() : props.onClose()}>
      <Tip label={t`Show outline`}>
        <PopoverTrigger asChild>
          <button type="button" className="pdf-outline-trigger" aria-label={t`Show document outline`} title={t`Show outline`}>
            <ListTree size={14} />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" sideOffset={7} className="document-outline-popover" aria-label={t`Document outline`}>
        <div className="document-outline-header"><ListTree size={13} /><span>{t`Outline`}</span></div>
        {props.nodes.length
          ? <OutlineBranch nodes={props.nodes} activeId={props.activeId ?? null} onSelect={props.onSelect} />
          : <p className="document-outline-empty">{t`No sections yet. Add a \\section{…} to start the outline`}</p>}
      </PopoverContent>
    </Popover>
  );
}
