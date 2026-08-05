import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { Bold, Code, Highlighter, Italic, Sigma, Strikethrough, Underline } from 'lucide-react';
import { Button } from '@ok-app/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatShortcut,
  type KeyboardShortcutId,
} from '@ok-app/lib/keyboard-shortcuts';
import { useLingui } from '@ok-app/shims/lingui-react-macro';

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

function canConvertSelectionToInlineMath(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.schema.nodes.mathInline) return false;
  const { selection } = editor.state;
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  if (!selection.$from.sameParent(selection.$to)) return false;

  let containsInlineAtom = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isInline && !node.isText) containsInlineAtom = true;
    return !containsInlineAtom;
  });
  if (containsInlineAtom) return false;

  return Boolean(editor.state.doc.textBetween(selection.from, selection.to, '').trim());
}

export function InlineFormatButtons({ editor }: { editor: Editor }) {
  const { t } = useLingui();
  const activeStates = useEditorState({
    editor,
    selector: (ctx) =>
      Object.fromEntries(formatActions.map((action) => [action.name, action.isActive(ctx.editor)])),
  });
  const canConvertToInlineMath = useEditorState({
    editor,
    selector: (ctx) => canConvertSelectionToInlineMath(ctx.editor),
  });

  const convertSelectionToInlineMath = (): void => {
    if (!canConvertSelectionToInlineMath(editor)) return;
    const { from, to } = editor.state.selection;
    const formula = editor.state.doc.textBetween(from, to, '');
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'mathInline',
        attrs: { formula, sourceDelimiter: '$' },
      })
      .run();
  };

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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t`Convert selection to inline math`}
            className="text-accent-foreground"
            disabled={!canConvertToInlineMath}
            onMouseDown={(e) => {
              e.preventDefault();
              convertSelectionToInlineMath();
            }}
          >
            <Sigma className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          {t`Convert selection to inline math`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
