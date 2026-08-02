import DOMPurify from "dompurify";
import katex from "katex";
import { Marked, type Tokens } from "marked";

type MathToken = Tokens.Generic & { text: string; display: boolean };

function renderMath(
  source: string,
  display: boolean,
  macros: Record<string, string>,
): string {
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      macros,
    });
  } catch (reason) {
    // KaTeX still throws for a few inputs even with throwOnError:false. Showing
    // the source beats blanking the message.
    const message = reason instanceof Error ? reason.message : String(reason);
    const escaped = source.replace(/[&<>]/g, (character) =>
      character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
    return `<code class="chat-math-error" title="${message.replace(/"/g, "&quot;")}">${escaped}</code>`;
  }
}

/**
 * `$…$` is also how people write money. Require a non-space just inside each
 * delimiter, and refuse a closing `$` that runs into a digit, so "$5 and $10"
 * stays prose while "$x_1$" is math. This mirrors what markdown-it-katex does.
 */
const INLINE_DOLLAR = /^\$(?![\s$])((?:\\.|[^\\$])+?)(?<![\s\\])\$(?!\d)/;
const INLINE_PAREN = /^\\\((.+?)\\\)/s;
const BLOCK_DOLLAR = /^\$\$([\s\S]+?)\$\$/;
const BLOCK_BRACKET = /^\\\[([\s\S]+?)\\\]/;

function mathExtensions(macros: Record<string, string>) {
  const block = (name: string, pattern: RegExp) => ({
    name,
    level: "block" as const,
    start: (src: string) => {
      const index = src.search(/\$\$|\\\[/);
      return index < 0 ? undefined : index;
    },
    tokenizer(src: string) {
      const match = pattern.exec(src);
      if (!match) return undefined;
      return { type: name, raw: match[0], text: match[1].trim(), display: true };
    },
    renderer: (token: MathToken) =>
      `<div class="chat-math-block">${renderMath(token.text, true, macros)}</div>`,
  });
  const inline = (name: string, pattern: RegExp) => ({
    name,
    level: "inline" as const,
    start: (src: string) => {
      const index = src.search(/\$|\\\(/);
      return index < 0 ? undefined : index;
    },
    tokenizer(src: string) {
      const match = pattern.exec(src);
      if (!match) return undefined;
      return { type: name, raw: match[0], text: match[1].trim(), display: false };
    },
    renderer: (token: MathToken) => renderMath(token.text, false, macros),
  });
  // Block first: `$$` must win over `$` on the same opening character.
  return [
    block("blockMathDollar", BLOCK_DOLLAR),
    block("blockMathBracket", BLOCK_BRACKET),
    inline("inlineMathParen", INLINE_PAREN),
    inline("inlineMathDollar", INLINE_DOLLAR),
  ];
}

/** Render one message to sanitized HTML. */
export function renderMarkdown(
  text: string,
  macros: Record<string, string> = {},
  options: { breaks?: boolean } = {},
): string {
  const marked = new Marked({ gfm: true, breaks: options.breaks ?? true });
  marked.use({ extensions: mathExtensions(macros) });
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    // KaTeX emits MathML alongside its HTML; keep both so copy/paste and
    // assistive tech get the real formula.
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ["target"],
  });
}

export function renderChatMarkdown(
  text: string,
  macros: Record<string, string> = {},
): string {
  return renderMarkdown(text, macros, { breaks: true });
}
