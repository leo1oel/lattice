/** Local host seam for the upstream View-in-Source bubble-menu entry. */
import type { Editor } from "@tiptap/react";
import { FileCode2 } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { Button } from "@ok-app/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ViewInSourceContext = createContext<((editor: Editor) => void) | null>(null);

export function ViewInSourceProvider({
  onViewInSource,
  children,
}: {
  onViewInSource?: (editor: Editor) => void;
  children: ReactNode;
}) {
  return (
    <ViewInSourceContext.Provider value={onViewInSource ?? null}>
      {children}
    </ViewInSourceContext.Provider>
  );
}

export function ViewInSourceBubbleButton({ editor }: { editor: Editor }): ReactNode {
  const onViewInSource = useContext(ViewInSourceContext);
  if (!onViewInSource) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="view-in-source-bubble-button"
          className="text-accent-foreground/80"
          aria-label="View in source Markdown"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onViewInSource(editor)}
        >
          <FileCode2 className="size-4" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        View in source Markdown
      </TooltipContent>
    </Tooltip>
  );
}
