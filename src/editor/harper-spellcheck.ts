import { forceLinting, linter, type Action, type Diagnostic } from "@codemirror/lint";
import { StateEffect, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";

type HarperSuggestionSnapshot = {
  kind: "replace" | "remove" | "insert-after";
  replacement: string;
};

/** Shape of `harper_lint` results (src-tauri/src/harper.rs), spans in UTF-16 code units. */
type HarperLintResult = {
  start: number;
  end: number;
  kind: string;
  message: string;
  suggestions: HarperSuggestionSnapshot[];
};

type AddProjectWord = (word: string) => boolean | Promise<boolean>;

type HarperDiagnosticOptions = {
  projectWords?: string[];
  onAddProjectWord?: AddProjectWord;
};

export const harperDictionaryChanged = StateEffect.define<null>();

const words = (list: string) => list.trim().split(/\s+/);

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX command and environment names, not interface copy */
/** Every argument of these commands is an identifier, path, or key rather than prose. */
const OPAQUE_COMMANDS = new Set(words(`
  addbibresource author autocite begin bibliography bibliographystyle cite citealp citealt citeauthor citep citet
  cref Cref documentclass end eqref footcite graphicspath include includegraphics input label newcommand
  newenvironment pageref parencite path providecommand ref renewcommand renewenvironment textcite url usepackage
`));

/** How many leading arguments of these commands are colors or URLs; the rest is prose. */
const NON_PROSE_ARGUMENTS = new Map([
  ["color", 1], ["colorbox", 1], ["fcolorbox", 2], ["href", 1], ["pagecolor", 1], ["textcolor", 1],
]);

const NON_PROSE_ENVIRONMENTS = new Set(words(`
  align align* displaymath equation equation* gather gather* lstlisting math minted multline multline*
  tikzpicture verbatim verbatim*
`));
/* eslint-enable lingui/no-unlocalized-strings */

const COMMAND = /\\([A-Za-z@]+|.)/y;

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function balancedGroupEnd(source: string, start: number, open: string, close: string): number {
  if (source[start] !== open) return start;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (isEscaped(source, index)) continue;
    if (source[index] === open) depth += 1;
    if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function maskMarkdownTables(source: string, blank: (from: number, to: number) => void): void {
  const lines: Array<{ from: number; to: number; text: string }> = [];
  let from = 0;
  for (const text of source.split("\n")) {
    lines.push({ from, to: from + text.length, text: text.replace(/\r$/, "") });
    from += text.length + 1;
  }
  const isDelimiter = (line: string) => {
    const trimmed = line.trim();
    return trimmed.includes("|")
      && trimmed.replace(/^\||\|$/g, "").split("|").every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  };
  for (let index = 1; index < lines.length; index += 1) {
    if (!isDelimiter(lines[index].text) || !lines[index - 1].text.includes("|")) continue;
    let end = index + 1;
    while (end < lines.length && lines[end].text.includes("|")) end += 1;
    for (let row = index - 1; row < end; row += 1) blank(lines[row].from, lines[row].to);
    index = end - 1;
  }
}

/**
 * Replace LaTeX syntax and Markdown tables with spaces while preserving every UTF-16 offset.
 * Harper can then lint ordinary prose and its spans still map directly back
 * into CodeMirror's document positions.
 */
export function maskLatexForHarper(source: string): { prose: string; syntaxMask: boolean[] } {
  const masked = source.split("");
  const syntaxMask = new Array<boolean>(source.length).fill(false);
  const preambleProseRanges: Array<{ from: number; to: number }> = [];
  const isLineBreak = (index: number) => masked[index] === "\n" || masked[index] === "\r";
  const blank = (from: number, to: number) => {
    for (let index = from; index < Math.min(to, masked.length); index += 1) {
      if (isLineBreak(index)) continue;
      masked[index] = " ";
      syntaxMask[index] = true;
    }
  };
  const maskMath = (from: number, to: number) => {
    blank(from, to);
    // Preserve a neutral subject for Harper while keeping every source offset.
    // If math opens a sentence, the following prose is not itself the sentence
    // start (`$g$ shares`, for example), so it should not be forced uppercase.
    let cursor = from;
    while (cursor < Math.min(to, masked.length) && isLineBreak(cursor)) cursor += 1;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- placeholder subject fed to Harper, never shown
    if (cursor < Math.min(to, masked.length)) masked[cursor] = "X";
  };
  const skipSpace = (from: number) => {
    while (/\s/.test(source[from] ?? "")) from += 1;
    return from;
  };
  /** Offset just past the first `closer` at or after `from`, or the end of the source. */
  const endAfter = (closer: string, from: number) => {
    const close = source.indexOf(closer, from);
    return close === -1 ? source.length : close + closer.length;
  };
  maskMarkdownTables(source, blank);

  let index = 0;
  while (index < source.length) {
    if (source[index] === "%" && !isEscaped(source, index)) {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      blank(index, end);
      index = end;
      continue;
    }

    if (source[index] === "$" && !isEscaped(source, index)) {
      const marker = source[index + 1] === "$" ? "$$" : "$";
      let close = source.indexOf(marker, index + marker.length);
      while (close !== -1 && isEscaped(source, close)) close = source.indexOf(marker, close + marker.length);
      const end = close === -1 ? source.length : close + marker.length;
      maskMath(index, end);
      index = end;
      continue;
    }

    if (source[index] !== "\\") {
      index += 1;
      continue;
    }

    const mathCloser = source[index + 1] === "(" ? "\\)" : source[index + 1] === "[" ? "\\]" : null;
    if (mathCloser) {
      const end = endAfter(mathCloser, index + 2);
      maskMath(index, end);
      index = end;
      continue;
    }

    COMMAND.lastIndex = index;
    const commandMatch = COMMAND.exec(source);
    if (!commandMatch) {
      index += 1;
      continue;
    }
    const command = commandMatch[1];
    let cursor = index + commandMatch[0].length;
    if (source[cursor] === "*") cursor += 1;

    if (command === "begin") {
      cursor = skipSpace(cursor);
      const groupEnd = balancedGroupEnd(source, cursor, "{", "}");
      const environment = source.slice(cursor + 1, Math.max(cursor + 1, groupEnd - 1));
      if (environment === "document") {
        // Package options, font declarations, color names, and macro bodies
        // are configuration rather than prose. Keep the rendered title, which
        // is the one preamble field authors still expect Harper to lint.
        let from = 0;
        for (const title of preambleProseRanges) {
          blank(from, title.from);
          from = Math.max(from, title.to);
        }
        blank(from, groupEnd);
        index = groupEnd;
        continue;
      }
      if (NON_PROSE_ENVIRONMENTS.has(environment)) {
        const end = endAfter(`\\end{${environment}}`, groupEnd);
        blank(index, end);
        index = end;
        continue;
      }
    }

    if (command === "title") {
      const argument = skipSpace(cursor);
      if (source[argument] === "{") {
        const end = balancedGroupEnd(source, argument, "{", "}");
        preambleProseRanges.push({ from: argument + 1, to: Math.max(argument + 1, end - 1) });
      }
    }

    blank(index, cursor);

    const opaqueArguments = OPAQUE_COMMANDS.has(command)
      ? Number.POSITIVE_INFINITY
      : NON_PROSE_ARGUMENTS.get(command) ?? 0;
    for (let groupsMasked = 0; opaqueArguments > 0 && cursor < source.length;) {
      cursor = skipSpace(cursor);
      const bracket = source[cursor] === "[" ? "]" : source[cursor] === "{" && groupsMasked < opaqueArguments ? "}" : null;
      if (!bracket) break;
      const end = balancedGroupEnd(source, cursor, source[cursor], bracket);
      blank(cursor, end);
      cursor = end;
      if (bracket === "}") groupsMasked += 1;
    }
    index = Math.max(cursor, index + 1);
  }

  masked.forEach((character, cursor) => {
    if (character !== "{" && character !== "}") return;
    masked[cursor] = " ";
    syntaxMask[cursor] = true;
  });
  return { prose: masked.join(""), syntaxMask };
}

const isSpellingKind = (kind: string) => kind === "Spelling" || kind === "Typo";

export function createHarperDiagnostic(input: {
  from: number;
  to: number;
  message: string;
  kind: string;
  suggestions: HarperSuggestionSnapshot[];
  projectWord?: string;
  onAddProjectWord?: AddProjectWord;
}): Diagnostic {
  const actions: Action[] = input.suggestions.slice(0, 1).map(({ kind, replacement }) => ({
    name: kind === "remove"
      ? i18n._(msg`Remove`)
      : kind === "insert-after" ? i18n._(msg`Insert “${replacement}”`) : i18n._(msg`Replace with “${replacement}”`),
    apply(view, from, to) {
      view.dispatch({ changes: kind === "insert-after" ? { from: to, insert: replacement } : { from, to, insert: replacement } });
    },
  }));
  const { projectWord, onAddProjectWord } = input;
  if (projectWord && onAddProjectWord) {
    actions.push({
      name: i18n._(msg`Add “${projectWord}” to project dictionary`),
      apply(view) {
        void Promise.resolve(onAddProjectWord(projectWord)).then((accepted) => {
          if (accepted === false) return;
          view.dispatch({ effects: harperDictionaryChanged.of(null) });
          forceLinting(view);
        });
      },
    });
  }
  return {
    from: input.from,
    to: input.to,
    severity: isSpellingKind(input.kind) ? "error" : "warning",
    source: "Harper",
    message: input.message,
    actions,
  };
}

let loadFailureReported = false;
let harperLintQueue: Promise<void> = Promise.resolve();

/**
 * Stable, deduplicated word list. Sorting keeps the backend's session cache
 * key stable across callers, so the lint group only rebuilds when the
 * dictionary genuinely changes.
 */
function normalizeProjectWords(list: string[]): string[] {
  const unique = new Map(list.map((word) => word.trim()).filter(Boolean).map((word) => [word.toLocaleLowerCase(), word]));
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

async function computeHarperDiagnostics(source: string, options: HarperDiagnosticOptions): Promise<Diagnostic[]> {
  if (source.trim().length === 0) return [];
  try {
    const { prose, syntaxMask } = maskLatexForHarper(source);
    // The engine is harper-core on the Rust side (src-tauri/src/harper.rs) —
    // the same engine harper.js wrapped, but off the WebView thread entirely.
    // Masking stays here so spans keep matching the document.
    const lints = await invoke<HarperLintResult[]>("harper_lint", {
      text: prose,
      projectWords: normalizeProjectWords(options.projectWords ?? []),
    });
    return lints.flatMap((lint) => {
      const from = Math.max(0, Math.min(source.length, lint.start));
      const to = Math.max(from, Math.min(source.length, lint.end));
      const problem = source.slice(from, to);
      // Masking commands with spaces preserves CodeMirror offsets, but Harper
      // can interpret a long masked command as excessive whitespace. Ignore
      // every lint that touches hidden LaTeX syntax; prose-only spans still map
      // directly to the original document.
      if (to <= from || !/[A-Za-z]/.test(problem) || syntaxMask.slice(from, to).some(Boolean)) return [];
      return [createHarperDiagnostic({
        from,
        to,
        message: lint.message,
        kind: lint.kind,
        suggestions: lint.suggestions,
        projectWord: isSpellingKind(lint.kind) && /^[A-Za-z][A-Za-z'’-]*$/.test(problem) ? problem : undefined,
        onAddProjectWord: options.onAddProjectWord,
      })];
    });
  } catch (error) {
    if (!loadFailureReported) {
      loadFailureReported = true;
      console.warn("Harper spellcheck could not start", error);
    }
    return [];
  }
}

export async function harperDiagnostics(
  source: string,
  options: HarperDiagnosticOptions = {},
): Promise<Diagnostic[]> {
  const run = harperLintQueue.then(() => computeHarperDiagnostics(source, options));
  harperLintQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Above this size, Harper lints only the visible ranges (plus margin) instead
 * of the whole document. Linting itself runs in the backend, but every pass
 * still masks the whole source here, ships it across IPC, and reparses it on a
 * 350 ms typing cadence, so a 2 MB document is paid for on each keystroke burst.
 * Typora-style guardrail: degrade the feature by size rather than pay for it
 * everywhere.
 */
export const HARPER_WINDOW_THRESHOLD = 120_000;
const HARPER_WINDOW_MARGIN = 2_000;

/**
 * Null → lint the whole document (small doc). Otherwise the union of visible
 * ranges expanded by the margin and snapped outward to line boundaries.
 * Known limitation: masking is approximate at window edges — an environment
 * opened above the window is not seen — a bounded false-positive trade
 * against whole-document lint cost.
 */
export function harperLintWindow(view: EditorView): { from: number; to: number } | null {
  const doc = view.state.doc;
  if (doc.length <= HARPER_WINDOW_THRESHOLD) return null;
  const from = Math.min(doc.length, ...view.visibleRanges.map((range) => range.from));
  const to = Math.max(0, ...view.visibleRanges.map((range) => range.to));
  if (to <= from) return { from: 0, to: 0 };
  return {
    from: doc.lineAt(Math.max(0, from - HARPER_WINDOW_MARGIN)).from,
    to: doc.lineAt(Math.min(doc.length, to + HARPER_WINDOW_MARGIN)).to,
  };
}

/** Harper prose diagnostics for an editor, reading the project dictionary live. */
export function harperSpellcheck(live?: {
  current: { spellingWords: string[]; onAddSpellingWord?: AddProjectWord };
}): Extension {
  return linter(async (view) => {
    const data = live?.current;
    const onAdd = data?.onAddSpellingWord;
    const window = harperLintWindow(view) ?? { from: 0, to: view.state.doc.length };
    if (window.to <= window.from) return [];
    const diagnostics = await harperDiagnostics(view.state.sliceDoc(window.from, window.to), {
      projectWords: data?.spellingWords ?? [],
      onAddProjectWord: onAdd && (async (word: string) => {
        if (await onAdd(word) === false) return false;
        const current = live?.current;
        const known = current?.spellingWords.some((existing) => existing.toLocaleLowerCase() === word.toLocaleLowerCase());
        if (current && !known) current.spellingWords = [...current.spellingWords, word];
        return true;
      }),
    });
    return diagnostics.map((diagnostic) => ({
      ...diagnostic,
      from: diagnostic.from + window.from,
      to: diagnostic.to + window.from,
    }));
  }, {
    delay: 350,
    needsRefresh: (update) => (
      // Windowed docs re-lint as new content scrolls into the window.
      (update.viewportChanged && update.state.doc.length > HARPER_WINDOW_THRESHOLD)
      || update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(harperDictionaryChanged)))
    ),
  });
}
