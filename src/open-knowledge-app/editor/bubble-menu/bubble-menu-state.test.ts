import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor as ReactEditor } from '@tiptap/react';
import { afterEach, describe, expect, it } from 'vitest';
import { sharedExtensions } from '../../../open-knowledge-core/extensions/shared.ts';
import { TiptapFindReplace } from '../find-replace/tiptap-find-replace-extension';
import { shouldShowBubbleMenu } from './bubble-menu-state';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function editorWithSelectedText(): ReactEditor {
  const editor = new Editor({
    extensions: [...sharedExtensions, TiptapFindReplace],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Drag me' }] }] },
  });
  editors.push(editor);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 5)));
  return editor as unknown as ReactEditor;
}

describe('shouldShowBubbleMenu', () => {
  it('shows for a text selection and hides while that selection is being dragged', () => {
    const editor = editorWithSelectedText();
    expect(shouldShowBubbleMenu({ editor, view: editor.view })).toBe(true);

    const dragging = { ...editor.view, dragging: { slice: editor.state.selection.content(), move: true } };
    expect(shouldShowBubbleMenu({ editor, view: dragging as unknown as EditorView })).toBe(false);
  });
});
