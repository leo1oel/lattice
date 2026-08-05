import { createContext, useContext, type ReactNode } from 'react';
import { MessageSquareText } from 'lucide-react';
import { Button } from '@ok-app/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const VisualCommentContext = createContext<(() => void) | null>(null);

export function VisualCommentProvider({
  onComment,
  children,
}: {
  onComment: (() => void) | null;
  children: ReactNode;
}) {
  return <VisualCommentContext.Provider value={onComment}>{children}</VisualCommentContext.Provider>;
}

/** Local bridge from the vendored bubble menu to Research Writer comments. */
export function CommentBubbleButton(): ReactNode {
  const onComment = useContext(VisualCommentContext);
  if (!onComment) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Comment"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onComment}
        >
          <MessageSquareText aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Comment</TooltipContent>
    </Tooltip>
  );
}
