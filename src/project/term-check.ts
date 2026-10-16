/**
 * The project's term rules read against its LaTeX: where the paper writes a
 * form a rule settles differently, and what confirming each place would
 * write. Only prose counts. A form inside math, a comment, a citation,
 * label or reference key, a path, a command's options or an unknown macro's
 * argument stays as written and is only counted, by the same reading of the
 * source Proofread trusts with its edits (`latex-protected.ts`).
 *
 * Matching ignores case so "Zero shot" opening a sentence is found, and
 * accepts the settled term with a capital first letter (or in title case, in
 * a heading) when the term itself is lower case. A term with capitals of its
 * own ("ResNet") is only ever accepted exactly, so a rule needs no list of
 * other forms to keep its capitalisation.
 */
import type { EnglishVariant, TermRule } from "../app-types";
import type { ProofreadTerms } from "../agent/agent-proofread";
import { protectedLatexSpans } from "../editor/latex/latex-protected";

export type TermSource = { path: string; text: string };

/** One place a rule asks to change. Offsets are UTF-16, into the text as read. */
export type TermHit = {
  term: string;
  path: string;
  from: number;
  to: number;
  text: string;
  replacement: string;
  line: number;
  /** The line around the form, clipped, for the list. */
  before: string;
  after: string;
  /** The words around the form, which a skip remembers the place by. */
  context: string;
  skipped: boolean;
};

export type TermRuleReport = {
  rule: TermRule;
  hits: TermHit[];
  /** Forms found where the paper is not prose, left as written. */
  kept: number;
};

const CONTEXT_CHARS = 32;
const LINE_CLIP = 60;

const escapeForm = (form: string) => form
  .trim()
  .split(/\s+/)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  // A space in a form matches a line wrap too, never a paragraph break.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a regular expression, not interface copy
  .join("(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)");

const collapse = (text: string) => text.replace(/\s+/g, " ");
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const titleCase = (text: string) => text.replace(/(^|[\s-])(\p{Ll})/gu, (_, gap: string, letter: string) => gap + letter.toLocaleUpperCase());
const startsLower = (text: string) => /^\p{Ll}/u.test(text);
const startsUpper = (text: string) => /^\p{Lu}/u.test(text);

/** The forms of `term` that already follow it. */
function accepted(term: string): Set<string> {
  const forms = new Set([term]);
  if (startsLower(term)) {
    forms.add(capitalize(term));
    forms.add(titleCase(term));
  }
  return forms;
}

/** What `found` becomes: the term, capitalised the way the place was. */
function replacementFor(term: string, found: string): string {
  if (!startsLower(term) || !startsUpper(found)) return term;
  const words = found.split(/[\s-]+/).filter(Boolean);
  return words.length > 1 && words.every(startsUpper) ? titleCase(term) : capitalize(term);
}

/** One expression for a rule's forms, longest first so a longer form wins its place. */
function termPattern(rule: TermRule): RegExp | null {
  const forms = [rule.term, ...rule.variants].map((form) => form.trim()).filter(Boolean);
  if (!forms.length) return null;
  forms.sort((left, right) => right.length - left.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.map(escapeForm).join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

/** Where the place sits, for remembering a skip: the form with the words around it. */
export function termContext(text: string, from: number, to: number): string {
  return collapse(`${text.slice(Math.max(0, from - CONTEXT_CHARS), from)}[${text.slice(from, to)}]${text.slice(to, to + CONTEXT_CHARS)}`).trim();
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Every rule's places across `sources`, in rule order, each rule's places in file and text order. */
export function checkTerms(sources: readonly TermSource[], rules: readonly TermRule[]): TermRuleReport[] {
  const reports = rules.map((rule) => ({ rule, pattern: termPattern(rule), hits: [] as TermHit[], kept: 0 }));
  for (const source of sources) {
    const { text, path } = source;
    const spans = protectedLatexSpans(text);
    let starts: number[] | null = null;
    for (const report of reports) {
      const { pattern, rule } = report;
      if (!pattern) continue;
      const fine = accepted(collapse(rule.term.trim()));
      const skipped = new Set((rule.skipped ?? []).filter((skip) => skip.path === path).map((skip) => skip.context));
      let span = 0;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const found = match[0];
        const from = match.index;
        const to = from + found.length;
        if (fine.has(collapse(found))) continue;
        while (span < spans.length && spans[span].to <= from) span += 1;
        if (span < spans.length && spans[span].from < to) {
          report.kept += 1;
          continue;
        }
        starts ??= lineStarts(text);
        const line = lineIndexAt(starts, from);
        const lineEnd = text.indexOf("\n", to);
        const before = text.slice(starts[line], from).trimStart();
        const after = text.slice(to, lineEnd < 0 ? text.length : lineEnd).trimEnd();
        const context = termContext(text, from, to);
        report.hits.push({
          term: rule.term,
          path,
          from,
          to,
          text: found,
          replacement: replacementFor(rule.term.trim(), found),
          line: line + 1,
          before: before.length > LINE_CLIP ? `…${before.slice(-LINE_CLIP)}` : before,
          after: after.length > LINE_CLIP ? `${after.slice(0, LINE_CLIP)}…` : after,
          context,
          skipped: skipped.has(context),
        });
      }
    }
  }
  return reports.map(({ rule, hits, kept }) => ({ rule, hits, kept }));
}

/**
 * The files `hits` change, as read and as changed. Where two rules claim
 * overlapping words, the first place (in text order) is changed and the
 * other left for the next check, which reads the changed text.
 */
export function applyTermHits(sources: readonly TermSource[], hits: readonly TermHit[]): Array<{ path: string; before: string; after: string }> {
  const files: Array<{ path: string; before: string; after: string }> = [];
  for (const source of sources) {
    const mine = hits.filter((hit) => hit.path === source.path).sort((left, right) => left.from - right.from);
    if (!mine.length) continue;
    let after = "";
    let cursor = 0;
    for (const hit of mine) {
      if (hit.from < cursor || source.text.slice(hit.from, hit.to) !== hit.text) continue;
      after += source.text.slice(cursor, hit.from) + hit.replacement;
      cursor = hit.to;
    }
    after += source.text.slice(cursor);
    if (after !== source.text) files.push({ path: source.path, before: source.text, after });
  }
  return files;
}

/* eslint-disable lingui/no-unlocalized-strings -- model input, not interface copy */
const VARIANT_NAMES: Record<EnglishVariant, string> = {
  american: "American", british: "British", canadian: "Canadian", australian: "Australian",
};

/**
 * What Proofread and Polish are told about the project's English and the
 * rules whose forms occur in `excerpt` (a rule with nothing to say there
 * only lengthens the prompt).
 */
export function termGuidance(excerpt: string, rules: readonly TermRule[], variant: EnglishVariant | null): ProofreadTerms {
  const relevant = rules.filter((rule) => termPattern(rule)?.test(excerpt));
  return {
    spelling: variant ? `Spell in ${VARIANT_NAMES[variant]} English throughout; the project settles it.` : null,
    rules: relevant.length ? [
      "The project settles these terms. Write each exactly as given (capitalised at a sentence start)",
      "and change the other forms listed after it, in prose only; this overrides the guidance above:",
      ...relevant.map((rule) => {
        const others = rule.variants.length ? ` (not ${rule.variants.map((form) => JSON.stringify(form)).join(", ")})` : "";
        return `- ${JSON.stringify(rule.term)}${others}${rule.note?.trim() ? `: ${rule.note.trim()}` : ""}`;
      }),
    ] : [],
  };
}
/* eslint-enable lingui/no-unlocalized-strings */
