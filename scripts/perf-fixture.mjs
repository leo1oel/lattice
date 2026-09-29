/**
 * Deterministic content of the performance-fixture project.
 *
 * Pure: no Node or DOM APIs, so the same bytes feed two consumers.
 *   - scripts/gen-perf-fixture.mjs writes them to disk for measuring the real
 *     app (docs/performance.md, "Measurement playbook").
 *   - tools/perf-bench/ serves them from an in-memory mock backend for the
 *     benchmark CI gates on (scripts/perf-bench.mjs).
 *
 * Everything derives from fixed seeds (no Math.random, no dates), so two runs
 * produce identical bytes and before/after measurements compare the same
 * documents. The default sizes are the playbook's; the benchmark passes
 * smaller ones so a CI run stays short.
 */

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "lattice performance viewport incremental parse render layout decoration " +
  "transaction editor document markdown latex snapshot durable collab pool " +
  "anchor heading paragraph fixture deterministic measure keystroke switch"
).split(" ");

function sentence(rand, words) {
  const parts = [];
  for (let i = 0; i < words; i += 1) parts.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const s = parts.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function paragraph(rand) {
  const sentences = 3 + Math.floor(rand() * 4);
  return Array.from({ length: sentences }, () => sentence(rand, 8 + Math.floor(rand() * 12))).join(" ");
}

function mdBlock(rand, index) {
  const kind = index % 25;
  if (kind === 0) return `## Section ${Math.floor(index / 25) + 1}: ${sentence(rand, 4)}`;
  if (kind === 7) {
    return [
      "| Metric | Before | After |",
      "| --- | --- | --- |",
      `| keystroke p95 | ${Math.floor(rand() * 90)} ms | ${Math.floor(rand() * 20)} ms |`,
      `| switch | ${Math.floor(rand() * 900)} ms | ${Math.floor(rand() * 200)} ms |`,
    ].join("\n");
  }
  if (kind === 12) {
    return ["```ts", `export function probe${index}(): number {`, `  return ${index} * 2;`, "}", "```"].join("\n");
  }
  if (kind === 18) return `$$\\sum_{i=0}^{${index}} x_i^2 = \\frac{${index}}{n}$$`;
  if (kind === 21) return `- ${sentence(rand, 6)}\n- ${sentence(rand, 6)}\n- ${sentence(rand, 6)}`;
  const math = kind === 4 ? ` Inline $x_{${index}} = y^2$ math.` : "";
  return paragraph(rand) + math;
}

/** `large.md`: grows block by block until it reaches `bytes`. */
function largeMarkdown(bytes) {
  const rand = rng(0x1a77);
  const blocks = [`# Lattice perf fixture`, ""];
  let size = 0;
  let index = 0;
  while (size < bytes) {
    const block = mdBlock(rand, index);
    blocks.push(block, "");
    size += block.length + 2;
    index += 1;
  }
  return blocks.join("\n");
}

function chapter(number, bytes) {
  const rand = rng(1000 + number);
  const lines = [`\\chapter{Chapter ${number}}`, `\\label{ch:${number}}`, ""];
  let size = 0;
  let section = 0;
  while (size < bytes) {
    section += 1;
    lines.push(`\\section{Section ${number}.${section}}`, "");
    for (let p = 0; p < 4; p += 1) {
      const text = paragraph(rand);
      lines.push(text, "");
      size += text.length;
    }
    lines.push(`\\begin{equation}\\label{eq:${number}-${section}} x_{${section}} = \\sum_i y_i \\end{equation}`, "");
  }
  return lines.join("\n");
}

const CODE_SAMPLES = [
  ["ts", (n, word) => [
    `// ${word} — probe ${n}: “typed” results stay in one pass`,
    `export function measure${n}(values: readonly number[]): number {`,
    `  let total = 0;`,
    `  for (const value of values) total += value * ${n};`,
    `  return total / Math.max(1, values.length);`,
    `}`,
  ]],
  ["python", (n, word) => [
    `# ${word} — sample ${n}: “quoted” notes`,
    `def summarize_${n}(rows):`,
    `    total = sum(row["value"] for row in rows)`,
    `    return {"count": len(rows), "mean": total / max(1, len(rows))}`,
  ]],
  ["rust", (n, word) => [
    `// ${word} — kernel ${n}`,
    `pub fn fold_${n}(items: &[u64]) -> u64 {`,
    `    items.iter().copied().fold(0, |acc, item| acc.wrapping_add(item * ${n}))`,
    `}`,
  ]],
  ["json", (n, word) => [
    `{`,
    `  "name": "${word}-${n}",`,
    `  "note": "renders — without layout shift",`,
    `  "values": [${n}, ${n + 1}, ${n + 2}]`,
    `}`,
  ]],
  ["latex", (n, word) => [
    `% ${word} — equation ${n}`,
    `\\begin{align}`,
    `  f_{${n}}(x) &= \\sum_{i=0}^{${n}} \\alpha_i x^i \\\\`,
    `  g_{${n}}(x) &= \\int_0^1 f_{${n}}(t)\\,\\mathrm{d}t`,
    `\\end{align}`,
  ]],
];

/**
 * `code.md`: a document of fenced code blocks in the languages the visual
 * editor highlights. Comments carry em dashes and curly quotes, as real prose
 * does, so the text is not Latin-1 — the case where JavaScript engines fall
 * back to two-byte strings for everything sliced out of it.
 */
function codeMarkdown(blocks) {
  const rand = rng(0xc0de);
  const parts = ["# Code samples — highlighting fixture", ""];
  for (let index = 0; index < blocks; index += 1) {
    const [language, sample] = CODE_SAMPLES[index % CODE_SAMPLES.length];
    parts.push(`## Sample ${index + 1}`, "", sentence(rand, 10), "");
    parts.push("```" + language, ...sample(index, WORDS[Math.floor(rand() * WORDS.length)]), "```", "");
  }
  return parts.join("\n");
}

/**
 * A text-only PDF of `pages` US-letter pages set in the standard Helvetica
 * font, so pdf.js needs no embedded font program. Every object offset is
 * computed, so the cross-reference table is exact and pdf.js does not have
 * to repair the file.
 */
function textPdf(pages) {
  const rand = rng(0x9df);
  const objects = [];
  const pageIds = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const escape = (text) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const catalog = add(null);
  const pagesId = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= pages; page += 1) {
    const lines = [`BT /F1 16 Tf 72 720 Td (${escape(`Page ${page}: ${sentence(rand, 5)}`)}) Tj ET`, "BT /F1 10 Tf 72 690 Td 13 TL"];
    for (let line = 0; line < 44; line += 1) lines.push(`(${escape(sentence(rand, 12))}) Tj T*`);
    lines.push("ET", `0.2 w 72 80 m 540 80 l S`, `BT /F1 9 Tf 300 60 Td (${page}) Tj ET`);
    const stream = lines.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    ));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;

  // Every byte is ASCII, so string length equals byte offset.
  let output = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(output.length);
  for (let index = 0; index < output.length; index += 1) bytes[index] = output.charCodeAt(index);
  return bytes;
}

/** A latexmk-shaped log of about `lines` lines, ending in a few warnings. */
function buildLog(lines) {
  const rand = rng(0x10c);
  const log = ["This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2026) (preloaded format=pdflatex)", "entering extended mode"];
  for (let line = 0; line < lines; line += 1) {
    if (line % 40 === 0) log.push(`(./chapters/ch${String((line / 40) % 8 + 1).padStart(2, "0")}.tex`);
    else if (line % 13 === 0) log.push(`Overfull \\hbox (${(rand() * 20).toFixed(5)}pt too wide) in paragraph at lines ${line}--${line + 3}`);
    else log.push(`[${line}] ${sentence(rand, 9)}`);
  }
  log.push("LaTeX Warning: There were undefined references.", "Output written on main.pdf.");
  return log.join("\n");
}

/** The default sizes: the playbook's long-document case. */
export const PLAYBOOK_FIXTURE = Object.freeze({
  largeMarkdownBytes: 2_000_000,
  chapterBytes: 125_000,
  chapters: 8,
  notes: 200,
  codeBlocks: 150,
  pdfPages: 200,
  logLines: 4_000,
});

/**
 * Every file of the fixture project, plus the build products the benchmark's
 * mock backend answers with (`buildLog`, `compiledPdf`). Paths are
 * project-relative.
 */
export function perfFixture(options = {}) {
  const sizes = { ...PLAYBOOK_FIXTURE, ...options };
  const files = new Map();
  files.set("large.md", largeMarkdown(sizes.largeMarkdownBytes));
  files.set("code.md", codeMarkdown(sizes.codeBlocks));
  const chapters = [];
  for (let number = 1; number <= sizes.chapters; number += 1) {
    const name = `chapters/ch${String(number).padStart(2, "0")}`;
    files.set(`${name}.tex`, chapter(number, sizes.chapterBytes));
    chapters.push(name);
  }
  files.set("main.tex", [
    "\\documentclass{book}",
    "\\usepackage{amsmath}",
    "\\newcommand{\\lattice}{\\textsc{Lattice}}",
    "\\begin{document}",
    ...chapters.map((name) => `\\include{${name}}`),
    "\\end{document}",
  ].join("\n"));
  for (let note = 0; note < sizes.notes; note += 1) {
    const rand = rng(9000 + note);
    files.set(
      `notes/note-${String(note).padStart(3, "0")}.md`,
      [`# Note ${note}`, "", paragraph(rand), "", `- TODO: ${sentence(rand, 5)}`].join("\n"),
    );
  }
  files.set("reference.pdf", textPdf(sizes.pdfPages));
  return { files, buildLog: buildLog(sizes.logLines), compiledPdf: textPdf(sizes.pdfPages) };
}
