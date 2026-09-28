// Lattice regression coverage for the parser escape provenance ported from
// inkeep/open-knowledge #4510 (v0.78.0); see docs/open-knowledge-updates.md.
import { describe, expect, it } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from './index.ts';

const manager = new MarkdownManager({ extensions: sharedExtensions });

function roundTrip(source: string): string {
  return manager.serialize(manager.parse(source));
}

/** Drop every source-fidelity attribute so the serializer re-derives the text. */
function canonical(source: string): string {
  const strip = (node: Record<string, unknown>): Record<string, unknown> => ({
    ...node,
    attrs: node.attrs
      ? Object.fromEntries(
          Object.entries(node.attrs as Record<string, unknown>).filter(([key]) => !key.startsWith('source')),
        )
      : undefined,
    content: (node.content as Record<string, unknown>[] | undefined)?.map(strip),
  });
  return manager.serialize(strip(manager.parse(source) as unknown as Record<string, unknown>) as never);
}

describe('escape provenance in multi-line containers', () => {
  it.each([
    '> quoted\n> \\[x\\] literal\n',
    '- item\n  \\[x\\] literal\n',
    '> quoted\n> \\_a\\_b\n',
    '- a \\<br> b\n  ==c==\n',
    '> line \\==one\n> ==two==\n',
  ])('keeps the authored escapes of %j', (source) => {
    expect(roundTrip(source)).toBe(source);
    expect(canonical(source)).toBe(source);
  });

  it('does not turn an escaped continuation-line bracket into a reference link', () => {
    const source = '> intro\n> \\[foo\\] stays text\n\n[foo]: https://example.com\n';
    expect(canonical(source)).toBe(source);
    expect(JSON.stringify(manager.parse(source))).not.toContain('"type":"link"');
  });
});

describe('escaped HTML openers', () => {
  it.each(['a \\<u>x\\</u> b\n', '> \\<u>x\\</u>\n> y\n'])(
    'never duplicates the surrounding text of %j',
    (source) => {
      const text = JSON.stringify(manager.parse(source));
      expect(text).not.toContain('"a a');
      expect(text).not.toContain('"xx"');
    },
  );
});
