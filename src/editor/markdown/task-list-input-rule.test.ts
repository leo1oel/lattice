import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import { sharedExtensions } from '../../open-knowledge-core/extensions/shared.ts';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const host = editor.options.element as HTMLElement;
    editor.destroy();
    host.remove();
  }
});

function mountEditor(content?: JSONContent): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({ element: host, extensions: sharedExtensions, content, editable: true });
  editor.view.focus();
  editors.push(editor);
  return editor;
}

function deliver(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  return editor.view.someProp('handleTextInput', (handler) =>
    (handler as TextInputHandler)(editor.view, from, to, text),
  ) ?? false;
}

function type(editor: Editor, text: string): void {
  for (const character of text) {
    if (!deliver(editor, character)) editor.view.dispatch(editor.state.tr.insertText(character));
  }
}

function pressBackspace(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function listItems(editor: Editor): PmNode[] {
  const items: PmNode[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'listItem') items.push(node);
  });
  return items;
}

describe('task-list input rules through a mounted Lattice editor', () => {
  it.each([
    ['[] ', false, null],
    ['[ ] ', false, null],
    ['[x] ', true, null],
    ['[X] ', true, 'X'],
  ] as const)('turns typed %j into a task item', (marker, checked, sourceCheckboxChar) => {
    const editor = mountEditor();
    type(editor, marker);

    expect(listItems(editor)).toHaveLength(1);
    expect(listItems(editor)[0].attrs).toMatchObject({ checked, sourceCheckboxChar });
    expect(editor.state.doc.textContent).toBe('');
  });

  it('turns character-by-character - [ ] into one task list, not nested lists', () => {
    const editor = mountEditor();
    type(editor, '- [ ] ');

    expect(listItems(editor)).toHaveLength(1);
    expect(listItems(editor)[0].attrs.checked).toBe(false);
    let listCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'list') listCount += 1;
    });
    expect(listCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('');
  });

  it.each([
    ['- [] ', false],
    ['- [ ] ', false],
    ['* [x] ', true],
  ] as const)('handles IME-style chunk delivery of %j', (marker, checked) => {
    const editor = mountEditor();
    expect(deliver(editor, marker)).toBe(true);
    expect(listItems(editor)[0]?.attrs.checked).toBe(checked);
    expect(editor.state.doc.textContent).toBe('');
  });

  it('Backspace undoes a bare task rule to its literal paragraph', () => {
    const editor = mountEditor();
    type(editor, '[x] ');

    expect(pressBackspace(editor)).toBe(true);
    expect(listItems(editor)).toHaveLength(0);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('[x] ');
  });

  it('does not retag an outer item when typed in its continuation paragraph', () => {
    const editor = mountEditor({
      type: 'doc',
      content: [{
        type: 'list',
        attrs: { ordered: false },
        content: [{
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            { type: 'paragraph' },
          ],
        }],
      }],
    });
    let continuation = -1;
    editor.state.doc.descendants((node, pos, parent, index) => {
      if (node.type.name === 'paragraph' && parent?.type.name === 'listItem' && index === 1) {
        continuation = pos + 1;
      }
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, continuation)));
    type(editor, '[ ] ');

    const items = listItems(editor);
    expect(items).toHaveLength(2);
    expect(items[0].attrs.checked).toBeNull();
    expect(items[1].attrs.checked).toBe(false);
  });
});
