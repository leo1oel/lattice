import { forceLinting, type Action, type Diagnostic } from "@codemirror/lint";
import { StateEffect } from "@codemirror/state";

type HarperSuggestionSnapshot = {
  kind: "replace" | "remove" | "insert-after";
  replacement: string;
};

export type HarperDiagnosticOptions = {
  projectWords?: string[];
  onAddProjectWord?: (word: string) => boolean | Promise<boolean>;
};

export const harperDictionaryChanged = StateEffect.define<null>();

const OPAQUE_COMMANDS = new Set([
  "addbibresource",
  "autocite",
  "begin",
  "bibliography",
  "cite",
  "citealp",
  "citealt",
  "citeauthor",
  "citep",
  "citet",
  "cref",
  "Cref",
  "documentclass",
  "end",
  "eqref",
  "footcite",
  "graphicspath",
  "include",
  "includegraphics",
  "input",
  "label",
  "newcommand",
  "newenvironment",
  "pageref",
  "parencite",
  "path",
  "providecommand",
  "ref",
  "renewcommand",
  "renewenvironment",
  "textcite",
  "url",
  "usepackage",
]);

const NON_PROSE_ENVIRONMENTS = new Set([
  "align",
  "align*",
  "displaymath",
  "equation",
  "equation*",
  "gather",
  "gather*",
  "lstlisting",
  "math",
  "minted",
  "multline",
  "multline*",
  "tikzpicture",
  "verbatim",
  "verbatim*",
]);

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

/**
 * Replace LaTeX syntax with spaces while preserving every UTF-16 offset.
 * Harper can then lint ordinary prose and its spans still map directly back
 * into CodeMirror's document positions.
 */
function maskLatexForHarper(source: string): { prose: string; syntaxMask: boolean[] } {
  const masked = Array.from({ length: source.length }, (_, index) => source[index]);
  const syntaxMask = Array.from({ length: source.length }, () => false);
  const blank = (from: number, to: number) => {
    for (let index = from; index < Math.min(to, masked.length); index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
        syntaxMask[index] = true;
      }
    }
  };
  const maskMath = (from: number, to: number) => {
    blank(from, to);
    // Preserve a neutral subject for Harper while keeping every source offset.
    // If math opens a sentence, the following prose is not itself the sentence
    // start (`$g$ shares`, for example), so it should not be forced uppercase.
    for (let cursor = from; cursor < Math.min(to, masked.length); cursor += 1) {
      if (masked[cursor] !== "\n" && masked[cursor] !== "\r") {
        masked[cursor] = "X";
        break;
      }
    }
  };

  let index = 0;
  while (index < source.length) {
    if (source[index] === "%" && !isEscaped(source, index)) {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }

    if (source[index] === "$" && !isEscaped(source, index)) {
      const marker = source[index + 1] === "$" ? "$$" : "$";
      let end = index + marker.length;
      while (end < source.length) {
        const match = source.indexOf(marker, end);
        if (match === -1) {
          end = source.length;
          break;
        }
        if (!isEscaped(source, match)) {
          end = match + marker.length;
          break;
        }
        end = match + marker.length;
      }
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
      const close = source.indexOf(mathCloser, index + 2);
      const end = close === -1 ? source.length : close + mathCloser.length;
      maskMath(index, end);
      index = end;
      continue;
    }

    const commandMatch = /^\\([A-Za-z@]+|.)/.exec(source.slice(index));
    if (!commandMatch) {
      index += 1;
      continue;
    }
    const command = commandMatch[1];
    let cursor = index + commandMatch[0].length;
    if (source[cursor] === "*") cursor += 1;

    if (command === "begin") {
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const groupEnd = balancedGroupEnd(source, cursor, "{", "}");
      const environment = source.slice(cursor + 1, Math.max(cursor + 1, groupEnd - 1));
      if (NON_PROSE_ENVIRONMENTS.has(environment)) {
        const closer = `\\end{${environment}}`;
        const close = source.indexOf(closer, groupEnd);
        const end = close === -1 ? source.length : close + closer.length;
        blank(index, end);
        index = end;
        continue;
      }
    }

    blank(index, cursor);

    if (OPAQUE_COMMANDS.has(command)) {
      let groupsMasked = 0;
      while (cursor < source.length) {
        while (/\s/.test(source[cursor] ?? "")) cursor += 1;
        if (source[cursor] === "[") {
          const end = balancedGroupEnd(source, cursor, "[", "]");
          blank(cursor, end);
          cursor = end;
          continue;
        }
        if (source[cursor] === "{" && (command !== "href" || groupsMasked === 0)) {
          const end = balancedGroupEnd(source, cursor, "{", "}");
          blank(cursor, end);
          cursor = end;
          groupsMasked += 1;
          if (command === "href") break;
          continue;
        }
        break;
      }
    }
    index = Math.max(cursor, index + 1);
  }

  for (let cursor = 0; cursor < masked.length; cursor += 1) {
    if (masked[cursor] === "{" || masked[cursor] === "}") {
      masked[cursor] = " ";
      syntaxMask[cursor] = true;
    }
  }
  return { prose: masked.join(""), syntaxMask };
}

export function maskLatexForProse(source: string): string {
  return maskLatexForHarper(source).prose;
}

export function createHarperDiagnostic(input: {
  from: number;
  to: number;
  message: string;
  kind: string;
  suggestions: HarperSuggestionSnapshot[];
  projectWord?: string;
  onAddProjectWord?: (word: string) => boolean | Promise<boolean>;
}): Diagnostic {
  const actions: Action[] = input.suggestions.slice(0, 1).map((suggestion) => ({
    name: suggestion.kind === "remove"
      ? "Remove"
      : suggestion.kind === "insert-after"
        ? `Insert “${suggestion.replacement}”`
        : `Replace with “${suggestion.replacement}”`,
    apply(view, from, to) {
      view.dispatch({
        changes: suggestion.kind === "insert-after"
          ? { from: to, to, insert: suggestion.replacement }
          : { from, to, insert: suggestion.replacement },
      });
    },
  }));
  if (input.projectWord && input.onAddProjectWord) {
    const projectWord = input.projectWord;
    actions.push({
      name: `Add “${projectWord}” to project dictionary`,
      apply(view) {
        void Promise.resolve(input.onAddProjectWord?.(projectWord)).then((accepted) => {
          if (accepted !== false) {
            view.dispatch({ effects: harperDictionaryChanged.of(null) });
            forceLinting(view);
          }
        });
      },
    });
  }
  return {
    from: input.from,
    to: input.to,
    severity: input.kind === "Spelling" || input.kind === "Typo" ? "error" : "warning",
    source: "Spelling",
    message: input.message,
    actions,
  };
}

let linterPromise: Promise<import("harper.js").LocalLinter> | null = null;
let loadFailureReported = false;
let importedProjectWordsKey = "";
let harperLintQueue: Promise<void> = Promise.resolve();

async function loadHarperLinter(): Promise<import("harper.js").LocalLinter> {
  linterPromise ??= Promise.all([import("harper.js"), import("harper.js/binary")]).then(
    async ([harper, binaryModule]) => {
      // Harper's module-Blob Worker never reaches its ready event in the
      // WKWebView used by Tauri, leaving every lint request pending forever.
      // LocalLinter uses the same offline WASM engine and completes reliably;
      // CodeMirror already debounces calls so ordinary edits stay responsive.
      const linter = new harper.LocalLinter({
        binary: binaryModule.binary,
        dialect: harper.Dialect.American,
      });
      await linter.setup();
      return linter;
    },
  );
  return linterPromise;
}

async function syncProjectWords(
  linter: import("harper.js").LocalLinter,
  words: string[],
): Promise<void> {
  const normalized = [...new Map(words
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => [word.toLocaleLowerCase(), word])).values()]
    .sort((left, right) => left.localeCompare(right));
  const key = normalized.join("\n");
  if (key === importedProjectWordsKey) return;
  await linter.clearWords();
  if (normalized.length) await linter.importWords(normalized);
  importedProjectWordsKey = key;
}

async function computeHarperDiagnostics(
  source: string,
  options: HarperDiagnosticOptions,
): Promise<Diagnostic[]> {
  if (source.trim().length === 0) return [];
  try {
    const [harper, linter] = await Promise.all([import("harper.js"), loadHarperLinter()]);
    await syncProjectWords(linter, options.projectWords ?? []);
    const { prose, syntaxMask } = maskLatexForHarper(source);
    const lints = await linter.lint(prose, { language: "plaintext", dedup: true, isolateEnglish: false });
    return lints.flatMap((lint) => {
      const span = lint.span();
      const from = Math.max(0, Math.min(source.length, span.start));
      const to = Math.max(from, Math.min(source.length, span.end));
      span.free();
      const problem = source.slice(from, to);
      const lintKind = lint.lint_kind();
      const suggestions = lint.suggestions().map((suggestion) => {
        const kind = suggestion.kind();
        const snapshot: HarperSuggestionSnapshot = {
          kind: kind === harper.SuggestionKind.Remove
            ? "remove"
            : kind === harper.SuggestionKind.InsertAfter
              ? "insert-after"
              : "replace",
          replacement: suggestion.get_replacement_text(),
        };
        suggestion.free();
        return snapshot;
      });
      const diagnostic = createHarperDiagnostic({
        from,
        to,
        message: lint.message(),
        kind: lintKind,
        suggestions,
        projectWord: (lintKind === "Spelling" || lintKind === "Typo") && /^[A-Za-z][A-Za-z'’-]*$/.test(problem)
          ? problem
          : undefined,
        onAddProjectWord: options.onAddProjectWord,
      });
      lint.free();
      // Masking commands with spaces preserves CodeMirror offsets, but Harper
      // can interpret a long masked command as excessive whitespace. Ignore
      // every lint that touches hidden LaTeX syntax; prose-only spans still map
      // directly to the original document.
      const touchesLatexSyntax = syntaxMask.slice(from, to).some(Boolean);
      return !touchesLatexSyntax && /[A-Za-z]/.test(problem) && to > from ? [diagnostic] : [];
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
