import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const BLOCK_COUNTS = [100, 1000, 5000, 10000, 20000] as const;

const BASELINE_ONLY_COUNTS = [500, 2500] as const;

const SEED = 0xf1de1117;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickIndex(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

function pickWeighted<T>(rand: () => number, items: readonly [T, number][]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}

const WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'veniam',
  'nostrud',
  'exercitation',
  'ullamco',
  'laboris',
  'nisi',
  'aliquip',
  'commodo',
  'duis',
  'aute',
  'irure',
  'reprehenderit',
  'voluptate',
  'velit',
  'esse',
  'cillum',
  'occaecat',
  'cupidatat',
  'proident',
  'anim',
  'culpa',
  'mollit',
  'deserunt',
  'fugiat',
  'officia',
  'pariatur',
];

const CODE_LANGS = ['ts', 'js', 'python', 'rust', 'bash', 'json', 'go', 'sql'];

const MDX_COMPONENTS = ['Note', 'Warning', 'Tip', 'Info', 'Callout'];

function words(rand: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[pickIndex(rand, WORDS.length)]);
  return out.join(' ');
}

function sentence(rand: () => number, min = 6, max = 14): string {
  const n = min + pickIndex(rand, max - min + 1);
  const body = words(rand, n);
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

function paragraphBlock(rand: () => number): string {
  const sentences = 2 + pickIndex(rand, 4);
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    let s = sentence(rand);
    const roll = rand();
    if (roll < 0.08) s = `${s.slice(0, -1)} with **bold** and _italic_ runs.`;
    else if (roll < 0.15) s = `${s.slice(0, -1)} with \`inline code\`.`;
    parts.push(s);
  }
  return parts.join(' ');
}

function headingBlock(rand: () => number, index: number): string {
  const level = 1 + pickIndex(rand, 3); // h1-h3
  const hashes = '#'.repeat(level);
  return `${hashes} Section ${index}: ${words(rand, 3 + pickIndex(rand, 3))}`;
}

function listBlock(rand: () => number): string {
  const ordered = rand() < 0.4;
  const items = 3 + pickIndex(rand, 4);
  const lines: string[] = [];
  for (let i = 0; i < items; i++) {
    const marker = ordered ? `${i + 1}.` : '-';
    lines.push(`${marker} ${sentence(rand, 4, 10)}`);
  }
  return lines.join('\n');
}

function codeBlock(rand: () => number): string {
  const lang = CODE_LANGS[pickIndex(rand, CODE_LANGS.length)];
  const lines = 3 + pickIndex(rand, 5);
  const body: string[] = [];
  for (let i = 0; i < lines; i++) {
    body.push(`  const ${WORDS[pickIndex(rand, WORDS.length)]}_${i} = ${pickIndex(rand, 1000)};`);
  }
  return [`\`\`\`${lang}`, ...body, '```'].join('\n');
}

function tableBlock(rand: () => number): string {
  const cols = 3 + pickIndex(rand, 2); // 3-4 cols
  const rows = 2 + pickIndex(rand, 4); // 2-5 rows
  const header = Array.from({ length: cols }, (_, i) => `Col${i + 1}`);
  const sep = Array.from({ length: cols }, () => '---');
  const lines = [`| ${header.join(' | ')} |`, `| ${sep.join(' | ')} |`];
  for (let r = 0; r < rows; r++) {
    const cells = Array.from({ length: cols }, () => words(rand, 2));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function mdxBlock(rand: () => number): string {
  const name = MDX_COMPONENTS[pickIndex(rand, MDX_COMPONENTS.length)];
  return `<${name}>\n\n${sentence(rand)}\n\n</${name}>`;
}

type BlockKind = 'paragraph' | 'heading' | 'list' | 'code' | 'table' | 'mdx';

const MIX: readonly [BlockKind, number][] = [
  ['paragraph', 40],
  ['heading', 25],
  ['list', 15],
  ['code', 10],
  ['table', 5],
  ['mdx', 5],
];

function renderBlock(kind: BlockKind, rand: () => number, index: number): string {
  switch (kind) {
    case 'paragraph':
      return paragraphBlock(rand);
    case 'heading':
      return headingBlock(rand, index);
    case 'list':
      return listBlock(rand);
    case 'code':
      return codeBlock(rand);
    case 'table':
      return tableBlock(rand);
    case 'mdx':
      return mdxBlock(rand);
  }
}

function generateDocument(blockCount: number, seed: number): string {
  const rand = mulberry32(seed);
  const blocks: string[] = [];
  for (let i = 0; i < blockCount; i++) {
    const kind = pickWeighted(rand, MIX);
    blocks.push(renderBlock(kind, rand, i));
  }
  return `${blocks.join('\n\n')}\n`;
}

/** Sections in the `large-realistic` corpus. */
const LARGE_REALISTIC_SECTIONS = 100;

/** Lines each `large-realistic` section occupies; the code-fence bodies
 *  interpolate their own absolute line index, so this stride is load-bearing. */
const LARGE_REALISTIC_SECTION_LINES = 20;

/**
 * The `large-realistic` corpus: a fixed section template repeated verbatim,
 * unlike the seeded-random `generateDocument` mix. It exists to exercise the
 * pipeline on prose-shaped input (headings, tight lists, fenced code, loose
 * paragraphs) rather than on the block-kind lottery, so it is deliberately
 * regular rather than random.
 */
function generateLargeRealistic(sections: number = LARGE_REALISTIC_SECTIONS): string {
  const lines: string[] = [];
  for (let section = 1; section <= sections; section++) {
    const base = (section - 1) * LARGE_REALISTIC_SECTION_LINES;
    lines.push(
      `## Section ${section} — Lorem elit labore minim`,
      'Ea reprehenderit pariatur sunt id amet tempor aliqua exercitation commodo.',
      'Lorem elit labore minim nisi aute cillum cupidatat deserunt ipsum.',
      'Ea reprehenderit pariatur sunt id amet tempor aliqua exercitation commodo.',
      'Lorem elit labore minim nisi aute cillum cupidatat deserunt ipsum.',
      '',
      '- Lorem elit labore minim nisi aute',
      '- Ea reprehenderit pariatur sunt id amet',
      '- Lorem elit labore minim nisi aute',
      '- Ea reprehenderit pariatur sunt id amet',
      '',
      '```typescript',
      `const val_${base + 12} = "Lorem elit labore";`,
      `const val_${base + 13} = "Ea reprehenderit pariatur";`,
      `const val_${base + 14} = "Lorem elit labore";`,
      `const val_${base + 15} = "Ea reprehenderit pariatur";`,
      '```',
      '',
      'Lorem elit labore minim nisi aute cillum cupidatat.',
      'Ea reprehenderit pariatur sunt id amet tempor aliqua.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Materialise the corpus next to this file. The generated Markdown is not
 * committed — it is ~7.5 MB of lorem ipsum that every consumer can rebuild
 * byte-for-byte from `SEED` — so run this only when you want the files on
 * disk for an external profiler:
 *
 *     node --experimental-strip-types src/open-knowledge-core/markdown/fixtures/perf/generate.ts
 *
 * In-process consumers should call `generateDocument` / `generateLargeRealistic`
 * (or the memoised loaders in `../index.ts`) instead of reading files.
 */
function main(): void {
  for (const count of [...BLOCK_COUNTS, ...BASELINE_ONLY_COUNTS]) {
    const doc = generateDocument(count, SEED);
    const target = resolve(OUT_DIR, `${count}.md`);
    writeFileSync(target, doc, 'utf8');
    console.log(`wrote ${target} (${doc.length.toLocaleString()} chars)`);
  }
  const realistic = generateLargeRealistic();
  const realisticTarget = resolve(OUT_DIR, 'large-realistic.md');
  writeFileSync(realisticTarget, realistic, 'utf8');
  console.log(`wrote ${realisticTarget} (${realistic.length.toLocaleString()} chars)`);
}

if (import.meta.main) main();

export {
  BASELINE_ONLY_COUNTS,
  BLOCK_COUNTS,
  generateDocument,
  generateLargeRealistic,
  LARGE_REALISTIC_SECTIONS,
  SEED,
};
