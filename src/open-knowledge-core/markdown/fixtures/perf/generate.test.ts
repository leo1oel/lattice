import { describe, expect, it } from 'vitest';
import {
  loadLargeRealistic,
  loadPerfFixture,
  PERF_BLOCK_COUNTS,
} from '../index.ts';
import {
  BASELINE_ONLY_COUNTS,
  BLOCK_COUNTS,
  generateDocument,
  generateLargeRealistic,
  LARGE_REALISTIC_SECTIONS,
  SEED,
} from './generate.ts';

/**
 * The perf corpus used to be committed as ~7.5 MB of generated Markdown. It is
 * now rebuilt on demand, which only works if generation stays deterministic —
 * these tests are what makes that safe to rely on. If one of them fails, a
 * change to the generator has silently redefined the benchmark corpus and any
 * numbers measured across that change are not comparable.
 */
describe('perf fixture generator', () => {
  it('is deterministic for a given seed and block count', () => {
    for (const count of [...BLOCK_COUNTS, ...BASELINE_ONLY_COUNTS]) {
      expect(generateDocument(count, SEED)).toBe(generateDocument(count, SEED));
    }
  });

  it('varies with the seed', () => {
    expect(generateDocument(100, SEED)).not.toBe(generateDocument(100, SEED + 1));
  });

  it('nests smaller corpora inside larger ones', () => {
    // Blocks come off one `rand` stream in order, so a bigger corpus extends a
    // smaller one rather than reshuffling it. That is what makes a benchmark at
    // 1000 blocks comparable with the same benchmark at 20000.
    const ordered = [...BLOCK_COUNTS].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      const smaller = generateDocument(ordered[i - 1], SEED);
      const larger = generateDocument(ordered[i], SEED);
      expect(larger.startsWith(smaller.trimEnd())).toBe(true);
    }
  });

  it('terminates every document with a trailing newline', () => {
    for (const count of [...BLOCK_COUNTS, ...BASELINE_ONLY_COUNTS]) {
      expect(generateDocument(count, SEED).endsWith('\n')).toBe(true);
    }
  });

  it('grows monotonically with the block count', () => {
    const sizes = BLOCK_COUNTS.map((count) => generateDocument(count, SEED).length);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it('covers every block kind the pipeline has to handle', () => {
    const doc = generateDocument(1000, SEED);
    expect(doc).toMatch(/^#{1,3} Section /m); // heading
    expect(doc).toMatch(/^- /m); // bullet list
    expect(doc).toMatch(/^\d+\. /m); // ordered list
    expect(doc).toMatch(/^```\w+$/m); // fenced code
    expect(doc).toMatch(/^\| Col1 \| Col2 \| Col3/m); // table
    expect(doc).toMatch(/^<(Note|Warning|Tip|Info|Callout)>$/m); // MDX
    expect(doc).toMatch(/\*\*bold\*\*/); // inline emphasis
    expect(doc).toMatch(/`inline code`/);
  });

  it('builds the large-realistic corpus with a fixed section stride', () => {
    const doc = generateLargeRealistic();
    expect(doc).toBe(generateLargeRealistic());
    const lines = doc.trimEnd().split('\n');
    expect(lines).toHaveLength(LARGE_REALISTIC_SECTIONS * 20);
    expect(lines[0]).toBe('## Section 1 — Lorem elit labore minim');
    expect(lines.at(-20)).toBe(
      `## Section ${LARGE_REALISTIC_SECTIONS} — Lorem elit labore minim`,
    );
    // Code-fence bodies interpolate their absolute line index; a stride change
    // would desynchronise them from their position in the document.
    expect(lines[12]).toBe('const val_12 = "Lorem elit labore";');
    expect(lines[32]).toBe('const val_32 = "Lorem elit labore";');
  });

  it('is reachable through the fixture loaders', () => {
    for (const count of PERF_BLOCK_COUNTS) {
      expect(loadPerfFixture(count)).toBe(generateDocument(count, SEED));
    }
    expect(loadLargeRealistic()).toBe(generateLargeRealistic());
  });
});
