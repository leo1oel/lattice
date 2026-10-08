import { useRef } from "react";
import { ListTree } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tip } from "../components/icon-tip";
import type { OutlineNode } from "../editor/latex/latex-outline";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

function OutlineBranch({ nodes, activeId, onSelect }: {
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
  onOpenChange: (open: boolean) => void;
  available: boolean;
}) {
  const { t } = useLingui();
  // Choosing an entry closes the popover and sends the editor to the entry,
  // which focuses it. Radix's close hands focus back to the trigger once the
  // popover's exit ends, and when the jump's file was slower to open than that
  // exit (the first jump into a file after a load), the trigger took focus
  // from the editor the jump had just focused. A jump owns focus instead.
  const choseRef = useRef(false);
  if (!props.available) return null;
  const select = (path: string, line: number) => {
    choseRef.current = true;
    props.onSelect(path, line);
  };
  return (
    <Popover open={props.open} onOpenChange={(open) => props.onOpenChange(open)}>
      <Tip label={t`Show outline`}>
        <PopoverTrigger asChild>
          <button type="button" className="pdf-outline-trigger" aria-label={t`Show document outline`}>
            <ListTree size={14} />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" sideOffset={7} className="document-outline-popover fluid-hover-surface" aria-label={t`Document outline`}
        onCloseAutoFocus={(event) => {
          if (!choseRef.current) return;
          choseRef.current = false;
          event.preventDefault();
        }}
      >
        <FluidHoverSurface selector=".document-outline-list button" preserveSelection />
        <div className="document-outline-header"><ListTree size={13} /><span>{t`Outline`}</span></div>
        {props.nodes.length
          ? <OutlineBranch nodes={props.nodes} activeId={props.activeId ?? null} onSelect={select} />
          : <p className="document-outline-empty">{t`No sections yet. Add a \\section{…} to start the outline`}</p>}
      </PopoverContent>
    </Popover>
  );
}
