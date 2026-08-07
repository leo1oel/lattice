/* Local seam — not upstream code. Tests for heading-anchors-stateful.ts. */
import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { headingAnchorsStatefulKey, headingAnchorsStatefulPlugin } from './heading-anchors-stateful';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
    },
    text: { group: 'inline' },
  },
});

function heading(text: string) {
  return schema.nodes.heading.create(null, schema.text(text));
}

function createState() {
  const doc = schema.nodes.doc.create(null, [
    heading('Hello World'),
    schema.nodes.paragraph.create(null, schema.text('body')),
    heading('Hello World'),
    heading('Other'),
  ]);
  return EditorState.create({ schema, doc, plugins: [headingAnchorsStatefulPlugin()] });
}

function decorationIds(state: EditorState): string[] {
  const set = headingAnchorsStatefulKey.getState(state);
  if (!set) return [];
  return set.find().map((deco) => (deco.spec as { id?: string }).id ?? readAttrId(deco));
}

// Decoration attrs aren't exposed on a public field; render through find()'s
// type attrs instead. node decorations store attrs on `deco.type.attrs`.
function readAttrId(deco: unknown): string {
  return ((deco as { type: { attrs: { id: string } } }).type.attrs ?? {}).id;
}

describe('headingAnchorsStatefulPlugin', () => {
  it('assigns slug ids with -N suffixes for duplicate headings', () => {
    const state = createState();
    expect(decorationIds(state)).toEqual(['hello-world', 'hello-world-1', 'other']);
  });

  it('returns the identical DecorationSet instance for selection-only transactions', () => {
    const state = createState();
    const before = headingAnchorsStatefulKey.getState(state);
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 3));
    const next = state.apply(tr);
    expect(headingAnchorsStatefulKey.getState(next)).toBe(before);
  });

  it('rebuilds decorations when the document changes', () => {
    const state = createState();
    const before = headingAnchorsStatefulKey.getState(state);
    const tr = state.tr.insertText('X', 2);
    const next = state.apply(tr);
    const after = headingAnchorsStatefulKey.getState(next);
    expect(after).not.toBe(before);
    expect(decorationIds(next)).toEqual(['hxello-world', 'hello-world', 'other']);
  });
});
