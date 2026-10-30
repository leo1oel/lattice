/**
 * Landing a reverse SyncTeX jump on the word that was double-clicked, not
 * only its line. SyncTeX answers with a line, and a LaTeX paragraph is often
 * one long source line, so the clicked word is looked for in that line.
 *
 * The PDF's words are the source after TeX read it: command names, braces,
 * accents spelled `\'e`, `~` ties and `%` comments are gone, ligatures are
 * single glyphs, and a citation reads `[12]` where the source names a key.
 * Both sides are compared as runs of letters and digits, without accents or
 * case, and the source's markup is skipped while reading its words.
 *
 * One PDF line is usually a slice of the source line, so the clicked word is
 * told apart from its other occurrences by its neighbours first. Its
 * position among them settles a tie only when the PDF line holds the word
 * as often as the source line does; anything still ambiguous lands on the
 * line, as the jump always did.
 */
import type { SyncTexWord } from "../../app-types";

/** One run of letters and digits; combining marks keep a decomposed accent inside its word. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** Control symbols that change a letter rather than separate words: accents, `\-` (a hyphenation point). */
const IN_WORD_SYMBOL = /['"`^~=.-]/;
/** Accents spelled as one-letter commands: `Dvo\v{r}\'ak` is one word. */
const IN_WORD_COMMAND = /^[uvHcdbtrk]$/;
/**
 * Commands whose argument is a key or a name, never text on the page: what
 * they print (a citation's number, a reference's label) is not in the source.
 */
const KEY_ARGUMENT = /^(?:[A-Za-z]*cite[A-Za-z]*|[A-Za-z]*ref|label|begin|end|includegraphics|input|include|usepackage|documentclass|[hv]space|bibliography|bibliographystyle)$/;

/** A word as both sides compare it: letters and digits, accents and case dropped, ligatures spelled out. */
function wordKey(text: string): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a Unicode normalization form
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/**
 * The word at `offset` in a line of PDF text, with where it stands in the
 * line: null when `offset` is on a space or punctuation.
 */
export function clickedWordIn(lineText: string, offset: number): SyncTexWord | null {
  const words = [...lineText.matchAll(WORD)].map((match) => ({
    key: wordKey(match[0]),
    from: match.index,
    to: match.index + match[0].length,
  })).filter((word) => word.key);
  const index = words.findIndex((word) => offset >= word.from && offset < word.to);
  if (index < 0) return null;
  const { key } = words[index]!;
  const same = words.filter((word) => word.key === key);
  return {
    word: key,
    occurrence: same.indexOf(words[index]!),
    count: same.length,
    before: words[index - 1]?.key ?? null,
    after: words[index + 1]?.key ?? null,
  };
}

type SourceWord = { key: string; from: number };

/** Skip the balanced `open`…`close` group starting at `index`; the index just past it. */
function skipGroup(line: string, index: number, open: string, close: string): number {
  let depth = 0;
  for (let at = index; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\") at += 1;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return at + 1;
  }
  return line.length;
}

/** A key command's starred form, optional and required arguments, from just past its name. */
function skipKeyArguments(line: string, index: number): number {
  let at = index;
  for (;;) {
    while (line[at] === " " || line[at] === "*") at += 1;
    if (line[at] === "[") at = skipGroup(line, at, "[", "]");
    else if (line[at] === "{") return skipGroup(line, at, "{", "}");
    else return at;
  }
}

/** The words a source line prints, each with the column it starts at. */
export function sourceWords(line: string): SourceWord[] {
  const words: SourceWord[] = [];
  let current: { text: string; from: number } | null = null;
  const end = () => {
    if (current) {
      const key = wordKey(current.text);
      if (key) words.push({ key, from: current.from });
    }
    current = null;
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "%") break;
    if (char === "\\") {
      const name = /^[A-Za-z@]+/.exec(line.slice(index + 1))?.[0];
      if (name === "i" || name === "j") {
        // The dotless letters an accent sits on: `na\"{\i}ve`.
        current ??= { text: "", from: index };
        current.text += name;
        index += 1;
      } else if (name) {
        if (!IN_WORD_COMMAND.test(name)) end();
        index += name.length;
        if (KEY_ARGUMENT.test(name)) index = skipKeyArguments(line, index + 1) - 1;
      } else {
        // `\'e` and `hy\-phen` stay one word; `\%`, `\&` and `\\` separate.
        if (!IN_WORD_SYMBOL.test(line[index + 1] ?? "")) end();
        index += 1;
      }
      continue;
    }
    // Braces only group: `\'{e}` and `{\em word}` read as plain letters.
    if (char === "{" || char === "}") continue;
    if (WORD_CHAR.test(char)) {
      current ??= { text: "", from: index };
      current.text += char;
      continue;
    }
    end();
  }
  end();
  return words;
}

/**
 * The column in source `line` where the clicked `word` starts, or null when
 * it is not there or its occurrences cannot be told apart.
 */
export function sourceColumnForWord(line: string, word: SyncTexWord): number | null {
  const words = sourceWords(line);
  const candidates = words.flatMap((item, index) => item.key === word.word ? [index] : []);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return words[candidates[0]!]!.from;
  const score = (index: number) => (
    Number(word.before !== null && words[index - 1]?.key === word.before)
    + Number(word.after !== null && words[index + 1]?.key === word.after)
  );
  const best = Math.max(...candidates.map(score));
  const top = candidates.filter((index) => score(index) === best);
  if (best > 0 && top.length === 1) return words[top[0]!]!.from;
  // The PDF line and the source line hold the word equally often: they are
  // most likely the same text, so its place among them is its place here.
  const byPosition = candidates.length === word.count ? candidates[word.occurrence] : undefined;
  return byPosition !== undefined && score(byPosition) === best ? words[byPosition]!.from : null;
}
