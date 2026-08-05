import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Bold, Code, Highlighter, Italic, Strikethrough, Underline } from 'lucide-react';
import { Button } from '@ok-app/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatShortcut,
  type KeyboardShortcutId,
} from '@ok-app/lib/keyboard-shortcuts';

const formatActions = [
  {
    name: 'bold',
    icon: Bold,
    command: (editor: Editor) => editor.chain().focus().toggleBold().run(),
    isActive: (editor: Editor) => editor.isActive('strong'),
    shortcutId: 'format-bold',
  },
  {
    name: 'italic',
    icon: Italic,
    command: (editor: Editor) => editor.chain().focus().toggleItalic().run(),
    isActive: (editor: Editor) => editor.isActive('emphasis'),
    shortcutId: 'format-italic',
  },
  {
    name: 'underline',
    icon: Underline,
    command: (editor: Editor) => editor.chain().focus().toggleUnderline().run(),
    isActive: (editor: Editor) => editor.isActive('underline'),
    shortcutId: 'format-underline',
  },
  {
    name: 'strikethrough',
    icon: Strikethrough,
    command: (editor: Editor) => editor.chain().focus().toggleStrike().run(),
    isActive: (editor: Editor) => editor.isActive('strike'),
    shortcutId: 'format-strike',
  },
  {
    name: 'code',
    icon: Code,
    command: (editor: Editor) => editor.chain().focus().toggleCode().run(),
    isActive: (editor: Editor) => editor.isActive('code'),
    shortcutId: 'format-inline-code',
  },
  {
    name: 'highlight',
    icon: Highlighter,
    command: (editor: Editor) => editor.chain().focus().toggleHighlight({ color: '#FFD875' }).run(),
    isActive: (editor: Editor) => editor.isActive('highlight'),
    shortcutId: 'format-highlight',
  },
] as const satisfies readonly {
  name: string;
  icon: typeof Bold;
  command: (editor: Editor) => boolean;
  isActive: (editor: Editor) => boolean;
  shortcutId: KeyboardShortcutId;
}[];

export function InlineFormatButtons({ editor }: { editor: Editor }) {
  const activeStates = useEditorState({
    editor,
    selector: (ctx) =>
      Object.fromEntries(formatActions.map((action) => [action.name, action.isActive(ctx.editor)])),
  });

  return (
    <div className="flex items-center gap-0.5">
      {formatActions.map((action) => {
        const Icon = action.icon;
        const active = activeStates[action.name];
        return (
          <Tooltip key={action.name}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={action.name}
                className={active ? 'bg-accent text-primary' : 'text-accent-foreground'}
                onMouseDown={(e) => {
                  e.preventDefault();
                  action.command(editor);
                }}
              >
                <Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              <span className="capitalize">{action.name} ({formatShortcut(action.shortcutId)})</span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
