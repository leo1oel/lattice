// Ported from inkeep/open-knowledge #4638 (v0.78.0) with jsx-node-target.ts.
import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../../open-knowledge-core/extensions/shared.ts';
import { MarkdownManager } from '../../../open-knowledge-core/markdown/index.ts';
import { isSameJsxElement, resolveJsxNodeTarget } from './jsx-node-target';

const schema = getSchema(sharedExtensions);
const manager = new MarkdownManager({ extensions: sharedExtensions });

function component(source: string) {
  return schema.nodeFromJSON(manager.parse(source)).child(0);
}

describe('JSX node targets', () => {
  test('resolves the live position and accepts equal replacement nodes', () => {
    const expected = component('<Callout title="Original">\nBody.\n</Callout>');
    const replacement = schema.nodeFromJSON(expected.toJSON());
    const prefix = schema.nodes.paragraph.create(null, schema.text('Shifted'));
    const doc = schema.node('doc', null, [prefix, replacement]);
    expect(resolveJsxNodeTarget(doc, () => prefix.nodeSize, expected)).toEqual({
      kind: 'current',
      pos: prefix.nodeSize,
      node: replacement,
    });
  });

  test('returns changed nodes so attribute writers can preserve their live properties', () => {
    const expected = component('<Callout title="Original">\nBody.\n</Callout>');
    const current = component('<Callout title="Updated">\nNew body.\n</Callout>');
    const doc = schema.node('doc', null, [current]);
    expect(resolveJsxNodeTarget(doc, () => 0, expected)).toEqual({
      kind: 'changed',
      pos: 0,
      node: current,
    });
    expect(isSameJsxElement(current, expected)).toBe(true);
    expect(isSameJsxElement(component('<Math formula="x" />'), expected)).toBe(false);
  });

  test('does not substitute position zero for a detached node', () => {
    const node = component('<Callout>\nBody.\n</Callout>');
    const doc = schema.node('doc', null, [node]);
    expect(resolveJsxNodeTarget(doc, () => undefined, node)).toEqual({ kind: 'removed' });
    expect(resolveJsxNodeTarget(doc, () => doc.content.size, node)).toEqual({ kind: 'removed' });
  });
});
