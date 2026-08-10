import { describe, expect, test } from 'vitest';
import { MarkdownManager } from '../markdown/index.ts';
import { sharedExtensions } from './shared';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

describe('Link extension round-trip', () => {
  test('inline link parses and serializes correctly', () => {
    const original = 'Check out [this link](https://example.com) for more.';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });

  test('link with title parses and serializes correctly', () => {
    const original = '[Example](https://example.com "My title")';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });

  test('multiple links in a paragraph round-trip correctly', () => {
    const original = 'See [foo](https://foo.com) and [bar](https://bar.com).';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });

  test('link href is preserved after round-trip', () => {
    const original = '[click here](https://example.com/path?q=1&r=2)';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });
});

describe('inline hash round-trip', () => {
  test('research quantity labels remain ordinary text', () => {
    const original = 'Model statistics: #Params, #Tokens, and #Samples';
    const parsed = mdManager.parse(original);

    expect(parsed.content?.[0]?.content).toEqual([
      { type: 'text', text: original },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('"type":"tag"');
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trimEnd()).toBe(original);
    expect(serialized).not.toContain('\\#');
  });
});

describe('document envelope round-trip', () => {
  test('frontmatter remains an envelope instead of empty editor paragraphs', () => {
    const original = '---\ntitle: Example\nauthors: [Ada]\n---\n\nBody.\n';
    const parsed = mdManager.parse(original);

    expect(parsed.content).toHaveLength(1);
    expect(parsed.content?.[0]?.type).toBe('paragraph');
    expect(mdManager.serialize(parsed)).toBe(original);
  });

  test('converter list normalization does not alter fenced code examples', () => {
    const original = '```md\n- 1.\nCode sample.\n```\n';
    const parsed = mdManager.parse(original);

    expect(parsed.content?.[0]?.type).toBe('codeBlock');
    expect(parsed.content?.[0]?.content?.[0]?.text).toBe('- 1.\nCode sample.');
    expect(mdManager.serialize(parsed)).toBe(original);
  });
});
