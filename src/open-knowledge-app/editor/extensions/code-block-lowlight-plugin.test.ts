import { Schema, type Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Plugin } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { describe, expect, test, vi } from 'vitest';
import { type LowlightLike, LowlightPlugin } from './code-block-lowlight-plugin';

const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: { group: 'block', content: 'text*', attrs: { align: { default: null } } },
    codeBlock: {
      group: 'block',
      content: 'text*',
      code: true,
      attrs: { language: { default: null } },
    },
    text: {},
  },
  marks: {},
});

function paragraph(text: string): PmNode {
  return schema.node('paragraph', null, text ? schema.text(text) : undefined);
}

function codeBlock(text: string, language: string | null = 'js'): PmNode {
  return schema.node('codeBlock', { language }, text ? schema.text(text) : undefined);
}

function mockLowlight() {
  return {
    highlight: vi.fn((language: string, value: string) => ({
      children: [{
        type: 'element' as const,
        properties: { className: [`hljs-${language}`] },
        children: [{ type: 'text' as const, value }],
      }],
    })),
    highlightAuto: vi.fn(),
    listLanguages: vi.fn(() => ['js', 'python']),
    registered: vi.fn(() => false),
  } satisfies LowlightLike;
}

function makeState(nodes: PmNode[], lowlight = mockLowlight()) {
  const plugin = LowlightPlugin({ name: 'codeBlock', lowlight, defaultLanguage: null });
  const state = EditorState.create({ doc: schema.node('doc', null, nodes), plugins: [plugin] });
  return { state, plugin, lowlight };
}

function decorations(plugin: Plugin, state: EditorState) {
  return (plugin.getState(state) as DecorationSet).find().map((decoration) => ({
    from: decoration.from,
    to: decoration.to,
    className: (decoration as unknown as { type: { attrs: { class?: string } } }).type.attrs.class,
  }));
}

function nodePositions(doc: PmNode, typeName: string): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === typeName) positions.push(pos);
  });
  return positions;
}

describe('LowlightPlugin incremental decorations', () => {
  test('ordinary paragraph edits map existing decorations without highlighting', () => {
    const setup = makeState([paragraph('before'), codeBlock('const x = 1')]);
    setup.lowlight.highlight.mockClear();

    const next = setup.state.apply(setup.state.tr.insertText('!', 2));

    expect(setup.lowlight.highlight).not.toHaveBeenCalled();
    expect(decorations(setup.plugin, next)).toEqual([
      expect.objectContaining({ className: 'hljs-js' }),
    ]);
  });

  test('deleting an adjacent paragraph maps the code block without highlighting it', () => {
    const setup = makeState([paragraph('remove me'), codeBlock('const x = 1')]);
    const paragraphSize = setup.state.doc.child(0).nodeSize;
    setup.lowlight.highlight.mockClear();

    const next = setup.state.apply(setup.state.tr.delete(0, paragraphSize));

    expect(setup.lowlight.highlight).not.toHaveBeenCalled();
    expect(decorations(setup.plugin, next)).toEqual([
      expect.objectContaining({ from: 1, className: 'hljs-js' }),
    ]);
  });

  test('editing one of 100 fenced blocks highlights only that block', () => {
    const setup = makeState(Array.from({ length: 100 }, (_, index) =>
      codeBlock(`const value${index} = ${index}`)
    ));
    const targetPos = nodePositions(setup.state.doc, 'codeBlock')[57];
    setup.lowlight.highlight.mockClear();

    const next = setup.state.apply(setup.state.tr.insertText('x', targetPos + 7));

    expect(setup.lowlight.highlight).toHaveBeenCalledTimes(1);
    expect(setup.lowlight.highlight.mock.calls[0][1]).toContain('x');
    expect(decorations(setup.plugin, next)).toHaveLength(100);
  });

  test('adding and deleting a fenced block updates only the changed block', () => {
    const setup = makeState([paragraph('first'), codeBlock('const kept = true')]);
    const insertPos = setup.state.doc.child(0).nodeSize;
    setup.lowlight.highlight.mockClear();

    const withAddedBlock = setup.state.apply(
      setup.state.tr.insert(insertPos, codeBlock('const added = true')),
    );

    expect(setup.lowlight.highlight).toHaveBeenCalledTimes(1);
    expect(setup.lowlight.highlight).toHaveBeenCalledWith('js', 'const added = true');

    setup.lowlight.highlight.mockClear();
    const addedPos = nodePositions(withAddedBlock.doc, 'codeBlock')[0];
    const addedNode = withAddedBlock.doc.nodeAt(addedPos);
    const afterDelete = withAddedBlock.apply(
      withAddedBlock.tr.delete(addedPos, addedPos + (addedNode?.nodeSize ?? 0)),
    );

    expect(setup.lowlight.highlight).not.toHaveBeenCalled();
    expect(decorations(setup.plugin, afterDelete)).toHaveLength(1);
  });

  test('language changes replace one block decorations, including empty-map AttrSteps', () => {
    const setup = makeState([codeBlock('const x = 1'), codeBlock('const y = 2')]);
    const firstPos = nodePositions(setup.state.doc, 'codeBlock')[0];
    const firstNode = setup.state.doc.nodeAt(firstPos);
    setup.lowlight.highlight.mockClear();

    const python = setup.state.apply(
      setup.state.tr.setNodeMarkup(firstPos, undefined, {
        ...firstNode?.attrs,
        language: 'python',
      }),
    );

    expect(setup.lowlight.highlight).toHaveBeenCalledTimes(1);
    expect(setup.lowlight.highlight).toHaveBeenCalledWith('python', 'const x = 1');
    expect(decorations(setup.plugin, python).map((item) => item.className)).toEqual([
      'hljs-python',
      'hljs-js',
    ]);

    setup.lowlight.highlight.mockClear();
    const unsupported = python.apply(
      python.tr.setNodeAttribute(firstPos, 'language', 'not-registered'),
    );

    expect(setup.lowlight.highlight).not.toHaveBeenCalled();
    expect(decorations(setup.plugin, unsupported).map((item) => item.className)).toEqual([
      'hljs-js',
    ]);
  });

  test('mapped remote edits rehighlight the touched block when selection is elsewhere', () => {
    const setup = makeState([
      paragraph('cursor stays here'),
      codeBlock('const remote = 1'),
      codeBlock('const untouched = 2'),
    ]);
    const codePos = nodePositions(setup.state.doc, 'codeBlock')[0];
    const state = setup.state.apply(
      setup.state.tr.setSelection(TextSelection.create(setup.state.doc, 2)),
    );
    setup.lowlight.highlight.mockClear();

    const remoteTransaction = state.tr.insertText('prefix ', 2);
    const mappedCodePos = remoteTransaction.mapping.map(codePos, 1);
    remoteTransaction.insertText('x', mappedCodePos + 7).setMeta('remote', true);
    state.apply(remoteTransaction);

    expect(setup.lowlight.highlight).toHaveBeenCalledTimes(1);
    expect(setup.lowlight.highlight.mock.calls[0][1]).toContain('x');
  });

  test('newline edits preserve plain newline boundaries between highlight decorations', () => {
    const setup = makeState([codeBlock('const x = 1')]);
    const codePos = nodePositions(setup.state.doc, 'codeBlock')[0];
    setup.lowlight.highlight.mockClear();

    const next = setup.state.apply(setup.state.tr.insertText('\n', codePos + 6));
    const specs = decorations(setup.plugin, next);

    expect(setup.lowlight.highlight).toHaveBeenCalledTimes(1);
    expect(specs).toHaveLength(2);
    expect(specs[0].to).toBe(codePos + 6);
    expect(specs[1].from).toBe(codePos + 7);
  });
});
