import type { ComarkNode, ComarkPlugin, ComarkTree, MarkdownItPlugin } from "@comark/react";
import { createParse, defineComarkPlugin } from "@comark/react/parse";
import binding from "@comark/react/plugins/binding";
import breaks from "@comark/react/plugins/breaks";
import emoji from "@comark/react/plugins/emoji";
import footnotes from "@comark/react/plugins/footnotes";
import headings from "@comark/react/plugins/headings";
import jsonRender from "@comark/react/plugins/json-render";
import math from "@comark/react/plugins/math";
import punctuation from "@comark/react/plugins/punctuation";
import security from "@comark/react/plugins/security";
import summary from "@comark/react/plugins/summary";
import toc from "@comark/react/plugins/toc";
import type Token from "markdown-it/lib/token.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

/** Preserve the TeX-style delimiters supported by the previous renderer. */
const markdownItBackslashMath: MarkdownItPlugin = (markdownIt) => {
  markdownIt.inline.ruler.before("escape", "math_inline_paren", (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== "\\(") return false;
    const end = state.src.indexOf("\\)", start + 2);
    if (end < 0 || state.src.slice(start + 2, end).includes("\n")) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = state.src.slice(start + 2, end).trim();
      token.markup = "\\(\\)";
    }
    state.pos = end + 2;
    return true;
  });

  markdownIt.inline.ruler.before("escape", "math_inline_bracket", (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== "\\[") return false;
    const end = state.src.indexOf("\\]", start + 2);
    if (end < 0 || state.src.slice(start + 2, end).includes("\n")) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = state.src.slice(start + 2, end).trim();
      token.markup = "\\[\\]";
      token.meta = { display: true };
    }
    state.pos = end + 2;
    return true;
  });

  markdownIt.block.ruler.before("fence", "math_block_bracket", (
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const firstLineEnd = state.eMarks[startLine];
    if (state.src.slice(start, start + 2) !== "\\[") return false;

    const firstLine = state.src.slice(start + 2, firstLineEnd);
    const sameLineEnd = firstLine.indexOf("\\]");
    let closingLine = startLine;
    const content: string[] = [];
    if (sameLineEnd >= 0) {
      content.push(firstLine.slice(0, sameLineEnd));
    } else {
      content.push(firstLine);
      for (closingLine = startLine + 1; closingLine < endLine; closingLine++) {
        const lineStart = state.bMarks[closingLine] + state.tShift[closingLine];
        const lineEnd = state.eMarks[closingLine];
        const line = state.src.slice(lineStart, lineEnd);
        const end = line.indexOf("\\]");
        if (end >= 0) {
          content.push(line.slice(0, end));
          break;
        }
        content.push(line);
      }
      if (closingLine >= endLine) return false;
    }

    if (silent) return true;
    const token = state.push("math_block", "div", 0);
    token.content = content.join("\n").trim();
    token.markup = "\\[\\]";
    token.block = true;
    token.map = [startLine, closingLine + 1];
    state.line = closingLine + 1;
    return true;
  }, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
};

const backslashMath = defineComarkPlugin(() => ({
  name: "backslash-math",
  markdownItPlugins: [markdownItBackslashMath],
}));

const safeMarkdown = security({
  blockedTags: ["script", "iframe", "object", "embed", "link", "style", "base", "meta"],
  allowedProtocols: ["http", "https", "mailto"],
});

function removeReactHtmlInjection(node: ComarkNode): void {
  if (!Array.isArray(node)) return;
  const attributes = node[1];
  for (const name of Object.keys(attributes)) {
    if (name.replace(/^:/, "").toLowerCase() === "dangerouslysetinnerhtml") {
      delete attributes[name];
    }
  }
  for (const child of node.slice(2) as ComarkNode[]) {
    if (child) removeReactHtmlInjection(child);
  }
}

const reactSecurity = defineComarkPlugin(() => ({
  name: "react-security",
  post(state) {
    for (const node of state.tree.nodes) removeReactHtmlInjection(node);
  },
}));

const markdownItSourceLines: MarkdownItPlugin = (markdownIt) => {
  markdownIt.core.ruler.push("source-lines", (state) => {
    for (const token of state.tokens) {
      if (!token.map) continue;
      if (token.level === 0 && token.nesting !== -1) {
        token.attrSet("data-source-line-relative", String(token.map[0] + 1));
        token.attrSet("data-source-end-line-relative", String(token.map[1]));
      }
      for (const child of token.children ?? []) {
        if (child.tag === "input" && child.attrGet("type") === "checkbox") {
          child.attrSet("data-task-line-relative", String(token.map[0] + 1));
        }
      }
    }
  });
};

function annotateInteractiveNodes(
  nodes: ComarkNode[],
  lineOffset: number,
  mathBlockLines: Array<{ start: number; end: number }>,
): void {
  let mathBlockIndex = 0;
  const visit = (node: ComarkNode, topLevel: boolean) => {
    if (!Array.isArray(node)) return;
    const attributes = node[1];
    if (topLevel && node[0] === "math" && String(attributes.class).includes("block")) {
      const mathLine = mathBlockLines[mathBlockIndex];
      mathBlockIndex += 1;
      if (mathLine !== undefined) {
        attributes["data-source-line"] = mathLine.start + lineOffset;
        attributes["data-source-end-line"] = mathLine.end + lineOffset;
      }
    }
    const relativeLine = Number(attributes["data-source-line-relative"]);
    const relativeEndLine = Number(attributes["data-source-end-line-relative"]);
    if (topLevel && Number.isFinite(relativeLine)) {
      attributes["data-source-line"] = relativeLine + lineOffset;
      delete attributes["data-source-line-relative"];
      if (Number.isFinite(relativeEndLine)) {
        attributes["data-source-end-line"] = relativeEndLine + lineOffset;
        delete attributes["data-source-end-line-relative"];
      }
    } else if (topLevel && typeof attributes.$?.line === "number") {
      attributes["data-source-line"] = attributes.$.line;
    }
    const relativeTaskLine = Number(attributes["data-task-line-relative"]);
    if (node[0] === "input" && Number.isFinite(relativeTaskLine)) {
      attributes["data-task-line"] = relativeTaskLine + lineOffset;
      delete attributes["data-task-line-relative"];
    }
    for (const child of node.slice(2) as ComarkNode[]) {
      if (child) visit(child, false);
    }
  };
  for (const node of nodes) visit(node, true);
}

const sourceMetadata = defineComarkPlugin(() => ({
  name: "source-metadata",
  markdownItPlugins: [markdownItSourceLines],
  post(state) {
    const mathBlockLines = (state.tokens as Token[])
      .filter((token) => token.type === "math_block" && token.level === 0 && token.map)
      .map((token) => ({ start: token.map![0] + 1, end: token.map![1] }));
    annotateInteractiveNodes(state.tree.nodes, state.parsedLines, mathBlockLines);
  },
}));

const builtInJsonRender = jsonRender();
const safeJsonRender = defineComarkPlugin(() => ({
  name: "safe-json-render",
  async post(state) {
    const fences: Array<{ parent: ComarkNode[]; index: number; node: ComarkNode }> = [];
    const collect = (nodes: ComarkNode[]) => {
      nodes.forEach((node, index) => {
        if (!Array.isArray(node)) return;
        const language = node[0] === "pre" ? node[1].language : undefined;
        if (language === "json-render" || language === "yaml-render") {
          fences.push({ parent: nodes, index, node });
          return;
        }
        collect(node as ComarkNode[]);
      });
    };
    collect(state.tree.nodes);
    await builtInJsonRender.post?.(state);

    // JSON Render requires an application-owned component catalog. This editor
    // has no such catalog, so never interpret spec-controlled types or props as
    // React/HTML. Keep the authored spec visible as an inert code fallback.
    for (const { parent, index, node } of fences) {
      parent[index] = [
        "pre",
        { class: "chat-json-render-fallback" },
        ...(node.slice(2) as ComarkNode[]),
      ];
    }
  },
}));

const basePlugins = [
  backslashMath(),
  math(),
  footnotes(),
  binding(),
  emoji(),
  headings(),
  safeJsonRender(),
  punctuation(),
  summary(),
  toc(),
  safeMarkdown,
  reactSecurity(),
  sourceMetadata(),
];
const pluginsWithBreaks = [...basePlugins, breaks()];
type ParserPair = {
  commonMark: ReturnType<typeof createParse>;
  softBreaks: ReturnType<typeof createParse>;
};

function createParserPair(optionalPlugins: ComarkPlugin[] = []): ParserPair {
  return {
    commonMark: createParse({
      autoClose: true,
      html: true,
      plugins: [...basePlugins, ...optionalPlugins],
    }),
    softBreaks: createParse({
      autoClose: true,
      html: true,
      plugins: [...pluginsWithBreaks, ...optionalPlugins],
    }),
  };
}

const optionalPlugins = new Map<string, Promise<ComarkPlugin[]>>();

function getOptionalPlugins(withHighlight: boolean, withMermaid: boolean) {
  const key = `${Number(withHighlight)}:${Number(withMermaid)}`;
  const cached = optionalPlugins.get(key);
  if (cached) return cached;
  const plugins = Promise.all([
    withHighlight
      ? import("@comark/react/plugins/highlight").then(({ default: highlight }) => highlight())
      : Promise.resolve(null),
    withMermaid
      ? import("comark/plugins/mermaid").then(({ default: mermaid }) => mermaid())
      : Promise.resolve(null),
  ]).then((loaded) => loaded.filter((plugin): plugin is ComarkPlugin => plugin !== null));
  optionalPlugins.set(key, plugins);
  return plugins;
}

function createMarkdownParser() {
  const baseParsers = createParserPair();
  const enhancedParsers = new Map<string, Promise<ParserPair>>();
  return async (text: string, softBreaks: boolean): Promise<ComarkTree> => {
    // Shiki and the Mermaid renderer are substantial, so only load their CoMark
    // entry points for documents containing the corresponding fenced blocks.
    const withMermaid = /^ {0,3}(?:`{3,}|~{3,})\s*mermaid(?:\s|$)/im.test(text);
    const withHighlight = /^ {0,3}(?:`{3,}|~{3,})\s*(?!mermaid(?:\s|$))[^\s`~]+/im.test(text);
    let parsers = baseParsers;
    if (withHighlight || withMermaid) {
      const key = `${Number(withHighlight)}:${Number(withMermaid)}`;
      let enhanced = enhancedParsers.get(key);
      if (!enhanced) {
        enhanced = getOptionalPlugins(withHighlight, withMermaid).then(createParserPair);
        enhancedParsers.set(key, enhanced);
      }
      parsers = await enhanced;
    }
    const parse = softBreaks ? parsers.softBreaks : parsers.commonMark;
    return parse(text);
  };
}

const parseOnce = createMarkdownParser();

export const createComarkMarkdownParser = () => createMarkdownParser();

export function parseComarkMarkdown(text: string, softBreaks: boolean): Promise<ComarkTree> {
  return parseOnce(text, softBreaks);
}
