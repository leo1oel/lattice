/** A change to a passage: replace `[from, to)` of its text with `insert`. */
type Change = { from: number; to: number; insert: string };

/**
 * An edit as it is drawn: the span of the passage it covers, widened to whole
 * words, the words there now (`deleted`) and the words it would put there
 * (`inserted`).
 */
export type InlineEditSpan<Edit extends Change> = { edit: Edit; from: number; to: number; deleted: string; inserted: string };

/** How far an edit that cuts into a word widens to show the whole word. */
const WORD_LIMIT = 32;

const isWordCharacter = (char: string | undefined) => Boolean(char?.trim());

/**
 * `edits` in order, each widened to whole words when it cuts into one, so
 * `␣of␣the␣` → `-of-the-` reads as `state of the art` → `state-of-the-art`,
 * but never into a neighbouring edit's span.
 */
export function inlineEditSpans<Edit extends Change>(text: string, edits: readonly Edit[]): InlineEditSpan<Edit>[] {
  const sorted = [...edits].sort((left, right) => left.from - right.from);
  const spans: InlineEditSpan<Edit>[] = [];
  sorted.forEach((edit, index) => {
    const floor = spans.at(-1)?.to ?? 0;
    const ceiling = sorted[index + 1]?.from ?? text.length;
    const deleted = text.slice(edit.from, edit.to);
    let from = edit.from;
    let to = edit.to;
    if (isWordCharacter(deleted[0]) || isWordCharacter(edit.insert[0])) {
      while (from > floor && edit.from - from < WORD_LIMIT && isWordCharacter(text[from - 1])) from -= 1;
    }
    if (isWordCharacter(deleted.at(-1)) || isWordCharacter(edit.insert.at(-1))) {
      while (to < ceiling && to - edit.to < WORD_LIMIT && isWordCharacter(text[to])) to += 1;
    }
    spans.push({ edit, from, to, deleted: text.slice(from, to), inserted: text.slice(from, edit.from) + edit.insert + text.slice(edit.to, to) });
  });
  return spans;
}
