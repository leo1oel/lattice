import { autoUpdate, computePosition, flip, hide, offset, shift } from '@floating-ui/dom';
import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useRef, useState } from 'react';
import { CommentBubbleButton } from '@ok-app/comments/CommentBubbleButton';
import { Separator } from '@ok-app/components/ui/separator';
import { BlockTypeSelector } from './BlockTypeSelector';
import { deriveEditorClipOptions } from './bubble-menu-clip';
import { shouldShowBubbleMenu } from './bubble-menu-state';
import { FileBubbleButtons, isFileNodeSelected } from './FileBubbleButtons';
import { FootnoteBubbleButton } from './FootnoteBubbleButton';
import { InlineFormatButtons } from './InlineFormatButtons';
import { LinkEditPopover } from './LinkEditPopover';
import { ViewInSourceBubbleButton } from './ViewInSourceBubbleButton';

export function BubbleMenuBar({
  editor,
  hidden = false,
  shortcutEnabled = true,
  commentOnly = false,
}: {
  editor: Editor;
  hidden?: boolean;
  shortcutEnabled?: boolean;
  commentOnly?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [tooltipKey, setTooltipKey] = useState(0);
  const stopAutoUpdateRef = useRef<(() => void) | null>(null);
  const editorElement = editor.options.element;
  const editorDocument = editorElement instanceof Element ? editorElement.ownerDocument : document;

  // File NodeSelection swaps the bar to its download controls. Images own
  // alignment in their hover toolbar, so selecting one does not open this
  // text-oriented bubble menu.
  const isFileMode = useEditorState({
    editor,
    selector: (ctx) => isFileNodeSelected(ctx.editor),
  });

  // Virtual element whose getBoundingClientRect always reflects the current
  // selection position. contextElement lets autoUpdate discover scroll ancestors
  // (including the overflow-y-auto editor container) automatically.
  const virtualEl = {
    getBoundingClientRect: () => {
      try {
        const { from, to } = editor.state.selection;
        return posToDOMRect(editor.view, from, to);
      } catch {
        return new DOMRect();
      }
    },
    contextElement: (editor as unknown as { editorView?: { dom: HTMLElement } }).editorView?.dom,
  };

  // Clips placement to the editor's visible content region and hides the bar
  // when the selection scrolls behind the toolbar / bottom composer / footer —
  // see bubble-menu-clip.ts for why the viewport alone is the wrong boundary.
  const clipOptions = deriveEditorClipOptions(editor);

  const onShow = () => {
    const popup = menuRef.current;
    if (!popup) return;
    stopAutoUpdateRef.current?.();
    stopAutoUpdateRef.current = autoUpdate(virtualEl, popup, () => {
      computePosition(virtualEl, popup, {
        placement: 'top',
        strategy: 'fixed',
        middleware: [offset(8), flip(clipOptions), shift({ padding: 8 }), hide(clipOptions)],
      })
        .then(({ x, y, middlewareData }) => {
          if (popup.isConnected) {
            popup.style.position = 'fixed';
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
            // Hide rather than clamp once the selection is fully occluded — a
            // clamped bar floats over the footer/composer with no visible
            // selection anchoring it.
            popup.style.visibility = middlewareData.hide?.referenceHidden ? 'hidden' : 'visible';
          }
        })
        .catch(() => {
          // Position calculation failed (e.g., detached element) — autoUpdate will retry
        });
    });
  };

  const onHide = () => {
    stopAutoUpdateRef.current?.();
    stopAutoUpdateRef.current = null;
    // Bump key to force remount of tooltip-bearing children — prevents "rogue tooltips"
    // that stay open after the bubble menu hides due to portal/z-index timing.
    setTooltipKey((k) => k + 1);
  };

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      data-testid="bubble-menu-bar"
      data-ok-vendor=""
      data-suppressed={hidden ? '' : undefined}
      appendTo={() => editorDocument.body}
      shouldShow={shouldShowBubbleMenu}
      updateDelay={250}
      // flip/shift/hide mirror the autoUpdate loop above: the plugin runs its
      // own computePosition on editor transactions (remote CRDT edits
      // included), so both paths must agree on clipping and on when the
      // selection counts as occluded — the plugin applies `referenceHidden`
      // itself.
      options={{
        onShow,
        onHide,
        strategy: 'fixed',
        flip: clipOptions,
        shift: { padding: 8 },
        hide: clipOptions,
      }}
      className="z-50 flex items-center gap-0.5 rounded-lg border bg-background p-1 shadow-md"
    >
      {commentOnly ? (
        <CommentBubbleButton key={`${tooltipKey}-comment`} />
      ) : isFileMode ? (
        <FileBubbleButtons key={`${tooltipKey}-file`} editor={editor} />
      ) : (
        <>
          <BlockTypeSelector editor={editor} />
          <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
          <InlineFormatButtons key={tooltipKey} editor={editor} />
          <LinkEditPopover
            key={`${tooltipKey}-link`}
            editor={editor}
            shortcutEnabled={shortcutEnabled}
          />
          <FootnoteBubbleButton key={`${tooltipKey}-footnote`} editor={editor} />
          <ViewInSourceBubbleButton key={`${tooltipKey}-view-source`} editor={editor} />
          <CommentBubbleButton key={`${tooltipKey}-comment`} />
        </>
      )}
    </BubbleMenu>
  );
}
