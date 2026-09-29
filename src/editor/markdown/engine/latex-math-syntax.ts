/**
 * LaTeX inline math, `\(…\)`, for the visual engine's parser (spec R-RT-21,
 * R-INL-2).
 *
 * CommonMark reads `\(` as an escaped parenthesis, and the TeX between the
 * delimiters is then tokenized as prose: an underscore in `\mathrm{a}_{b}`
 * pairs with one in the next formula and becomes emphasis across both. A
 * micromark text construct claims the whole span first, so nothing inside it
 * is ever read as Markdown. The span becomes mdast `inlineMath`, like `$…$`;
 * the node's source slice keeps its delimiters (see markdown-to-document).
 *
 * Display `\[ … \]` is recognized over whole blocks instead (see
 * markdown-document), where a lone `=` line would otherwise make a setext
 * heading of the formula's first line.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 * Built on micromark's extension API (MIT).
 */
import type { CompileContext, Extension as FromMarkdownExtension, Token } from "mdast-util-from-markdown";
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    latexMathText: "latexMathText";
    latexMathTextMarker: "latexMathTextMarker";
    latexMathTextData: "latexMathTextData";
  }
}

const BACKSLASH = 92;
const LEFT_PARENTHESIS = 40;
const RIGHT_PARENTHESIS = 41;

/** micromark codes for line endings are negative: CRLF, LF, CR. */
const lineEnding = (code: Code) => code !== null && code < -2;

/** A `\)` that closes the formula, tried at every backslash inside it. */
const closing: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code: Code) => {
      if (code !== BACKSLASH) return nok(code);
      effects.enter("latexMathTextMarker");
      effects.consume(code);
      return (next: Code) => {
        if (next !== RIGHT_PARENTHESIS) return nok(next);
        effects.consume(next);
        effects.exit("latexMathTextMarker");
        return ok;
      };
    };
  },
};

function tokenizeLatexMath(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let empty = true;
  const start: State = (code) => {
    effects.enter("latexMathText");
    effects.enter("latexMathTextMarker");
    effects.consume(code);
    return open;
  };
  const open: State = (code) => {
    if (code !== LEFT_PARENTHESIS) return nok(code);
    effects.consume(code);
    effects.exit("latexMathTextMarker");
    return between;
  };
  const between: State = (code) => {
    if (code === null) return nok(code);
    if (lineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    if (code === BACKSLASH) return effects.attempt(closing, close, escapeStart)(code);
    effects.enter("latexMathTextData");
    return data(code);
  };
  const close: State = (code) => {
    if (empty) return nok(code);
    effects.exit("latexMathText");
    return ok(code);
  };
  // A backslash that does not close the formula escapes the character after
  // it, so `\\)` is a TeX line break followed by `)`, not the delimiter.
  const escapeStart: State = (code) => {
    effects.enter("latexMathTextData");
    effects.consume(code);
    empty = false;
    return escaped;
  };
  const escaped: State = (code) => {
    if (code === null || lineEnding(code)) {
      effects.exit("latexMathTextData");
      return between(code);
    }
    effects.consume(code);
    return data;
  };
  const data: State = (code) => {
    if (code === null || lineEnding(code) || code === BACKSLASH) {
      effects.exit("latexMathTextData");
      return between(code);
    }
    empty = false;
    effects.consume(code);
    return data;
  };
  return start;
}

const latexMathText: Construct = { name: "latexMathText", tokenize: tokenizeLatexMath };

/** The micromark syntax extension: tried before character escapes at every backslash. */
export function latexMathSyntax(): Extension {
  return { text: { [BACKSLASH]: { ...latexMathText, add: "before" } as Construct } };
}

/** mdast: the span becomes `inlineMath` whose value is the TeX between the delimiters. */
export function latexMathFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      latexMathText(this: CompileContext, token: Token) {
        this.enter({ type: "inlineMath", value: "" }, token);
      },
    },
    exit: {
      latexMathText(this: CompileContext, token: Token) {
        const source = this.sliceSerialize(token);
        const node = this.stack[this.stack.length - 1] as { value: string };
        node.value = source.slice(2, -2);
        this.exit(token);
      },
    },
  };
}

/** A unified plugin that registers both halves on the processor. */
export function remarkLatexMath(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(latexMathSyntax());
  (data.fromMarkdownExtensions ??= []).push(latexMathFromMarkdown());
}
