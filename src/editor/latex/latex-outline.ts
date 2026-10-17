import { INCLUDE } from "./latex-symbols";
import { lineCounter, resolveTexPath } from "./latex-text";

type OutlineLevel = 1 | 2 | 3 | 4 | 5;

export type OutlineNode = {
  id: string;
  level: OutlineLevel;
  title: string;
  line: number;
  path: string;
  kind?: "section" | "input";
  /** `\section*` and its kin: listed, never numbered. */
  starred?: true;
  /** After `\appendix` (or inside an `appendices` environment). */
  appendix?: true;
  children: OutlineNode[];
};

const SECTION_COMMAND = /\\(part|chapter|section|subsection|subsubsection)(\*?)\{([^{}]*)\}/g;
/** Where the appendix starts: `\appendix`, or the appendix package's environment. */
const APPENDIX = /\\(?:appendix(?![A-Za-z@])|begin\{appendices\})/g;
const LEVELS: Record<string, OutlineLevel> = { part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5 };

/** What ends the body: an appendix, or the references. */
const BODY_END = /(?<!\\)\\(?:appendix(?![A-Za-z@])|begin\{appendices\}|bibliography\s*\{|printbibliography(?![A-Za-z@])|begin\{thebibliography\})/;
/** A comment, from the first `%` that is not escaped. */
const COMMENT = /(^|[^\\])%.*/;

/** Source the manuscript's body is read from: all of `path`, or its lines before `before`. */
export type BodySpan = { path: string; before: number | null };

/**
 * Where the manuscript's body ends, read as TeX reads it: from the root
 * document through each `\input`/`\include` in turn, to the first appendix
 * (`\appendix`, an `appendices` environment) or bibliography
 * (`\bibliography{…}`, `\printbibliography`, a `thebibliography`
 * environment). Returns what precedes it: each file read whole, and the lines
 * before it in the file holding it and in each file on the way there. Null
 * when nothing ends the body early; "unread" when the walk reached a file not
 * in `sources` before finding the end, as that file may hold it or end the
 * body's text.
 */
export function findBodyEnd(
  rootPath: string,
  sources: Record<string, string>,
  projectPaths: string[],
  maxDepth = 8,
): BodySpan[] | "unread" | null {
  const spans: BodySpan[] = [];
  const seen = new Set<string>();
  let unread = false;
  const walk = (path: string, depth: number): boolean => {
    if (depth > maxDepth || seen.has(path)) return false;
    seen.add(path);
    const source = sources[path];
    if (source == null) {
      unread = true;
      return false;
    }
    for (const [index, raw] of source.split("\n").entries()) {
      const line = raw.replace(COMMENT, "$1");
      const end = BODY_END.exec(line)?.index ?? Infinity;
      // The line's includes before the end are read first, and may end the body themselves.
      const ended = [...line.matchAll(INCLUDE)].some((match) => {
        const included = match.index < end ? resolveTexPath(match[1], projectPaths) : null;
        return included !== null && walk(included, depth + 1);
      }) || end !== Infinity;
      if (ended) {
        spans.push({ path, before: index + 1 });
        return true;
      }
    }
    spans.push({ path, before: null });
    return false;
  };
  const ended = walk(rootPath, 0);
  return unread ? "unread" : ended ? spans : null;
}

export function includedPathsIn(source: string, projectPaths: string[]): string[] {
  const paths = [...source.matchAll(INCLUDE)].map((match) => resolveTexPath(match[1], projectPaths));
  return [...new Set(paths.filter((path): path is string => path !== null))];
}

export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutline(node.children)]);
}

// eslint-disable-next-line lingui/no-unlocalized-strings -- Roman numeral glyphs, as TeX numbers parts
const ROMAN: Array<[number, string]> = [[50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
function roman(value: number): string {
  let rest = value;
  let out = "";
  for (const [step, glyph] of ROMAN) {
    for (; rest >= step; rest -= step) out += glyph;
  }
  return out;
}
/** A, B, … Z, AA, AB: the appendix counter as `\Alph` would set it, past Z too. */
const letters = (value: number): string => value <= 0 ? "" : letters(Math.floor((value - 1) / 26)) + String.fromCharCode(65 + (value - 1) % 26);

/**
 * Each section's number as the standard classes print it, by node id; a
 * starred heading has none. Chapters, when the document has any, lead every
 * number below them (a book's 2.1), and three levels are numbered from the
 * first (`secnumdepth`: a book's subsubsections and an article's paragraphs
 * are not). After `\appendix` the leading level counts again in letters.
 * Parts take Roman numerals and lead nothing. The source cannot see a class
 * that numbers differently or a counter set by hand; the PDF shows those.
 */
export function outlineNumbers(nodes: OutlineNode[]): Map<string, string> {
  const sections = flattenOutline(nodes).filter((node) => node.kind !== "input");
  const top = sections.some((node) => node.level === LEVELS.chapter) ? LEVELS.chapter : LEVELS.section;
  const deepest = top + 2;
  const counters = [0, 0, 0, 0, 0, 0];
  let parts = 0;
  let lettered = false;
  const numbers = new Map<string, string>();
  for (const node of sections) {
    if (node.starred) continue;
    if (node.level === LEVELS.part) {
      parts += 1;
      numbers.set(node.id, roman(parts));
      continue;
    }
    if (node.level < top || node.level > deepest) continue;
    if (node.appendix && !lettered && node.level === top) {
      lettered = true;
      counters[top] = 0;
    }
    counters[node.level] += 1;
    for (let level = node.level + 1; level < counters.length; level += 1) counters[level] = 0;
    const lead = lettered ? letters(counters[top]) : String(counters[top]);
    numbers.set(node.id, [lead, ...counters.slice(top + 1, node.level + 1)].join("."));
  }
  return numbers;
}

/** The sections still open after `nodes` (in document order), outermost first. */
function innermostSections(nodes: OutlineNode[]): OutlineNode[] {
  const stack: OutlineNode[] = [];
  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    stack.push(node);
  }
  return stack;
}

/** Nearest enclosing section nodes for a 1-based line (outer → inner). */
export function sectionBreadcrumbNodes(source: string, line: number, path = ""): OutlineNode[] {
  return innermostSections(flattenOutline(parseLatexOutline(source, path)).filter((node) => node.line <= line));
}

/** Innermost section covering path:line in a project outline. */
export function activeOutlineNode(nodes: OutlineNode[], path: string, line: number): OutlineNode | null {
  const sections = flattenOutline(nodes)
    .filter((node) => node.kind !== "input" && node.path === path && node.line <= line)
    .sort((left, right) => left.line - right.line || left.level - right.level);
  return innermostSections(sections).at(-1) ?? null;
}

/** Whether two outlines list the same headings, at the same lines, in the same tree. */
export function sameOutline(left: OutlineNode[], right: OutlineNode[]): boolean {
  return left === right || (left.length === right.length && left.every((node, index) => {
    const other = right[index];
    return node.id === other.id && node.level === other.level && node.title === other.title
      && node.line === other.line && node.path === other.path && node.kind === other.kind
      && node.starred === other.starred && node.appendix === other.appendix
      && sameOutline(node.children, other.children);
  }));
}

/** The section tree of a single file (includes are not followed). */
export function parseLatexOutline(source: string, path = ""): OutlineNode[] {
  return parseProjectOutline(path, { [path]: source }, []);
}

type OutlineEvent =
  | { kind: "section"; offset: number; level: OutlineLevel; title: string; starred: boolean }
  | { kind: "input"; offset: number; raw: string }
  | { kind: "appendix"; offset: number };

function outlineEvents(source: string): OutlineEvent[] {
  const sections = [...source.matchAll(SECTION_COMMAND)].map((match): OutlineEvent => ({
    kind: "section",
    offset: match.index,
    level: LEVELS[match[1]],
    title: match[3].replace(/\s+/g, " ").trim() || `(${match[1]})`,
    starred: match[2] === "*",
  }));
  const inputs = [...source.matchAll(INCLUDE)].map((match): OutlineEvent => ({
    kind: "input",
    offset: match.index,
    raw: match[1],
  }));
  const appendices = [...source.matchAll(APPENDIX)].map((match): OutlineEvent => ({ kind: "appendix", offset: match.index }));
  return [...sections, ...inputs, ...appendices].sort((left, right) => left.offset - right.offset);
}

export function parseProjectOutline(
  rootPath: string,
  sources: Record<string, string>,
  projectPaths: string[],
  options?: { maxDepth?: number },
): OutlineNode[] {
  const maxDepth = options?.maxDepth ?? 8;
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const visiting = new Set<string>();
  // Read in reading order across files, as TeX does: an \appendix in an
  // included file turns every heading after it into an appendix.
  let inAppendix = false;
  // A heading's id names it by file, level, title and which of its namesakes
  // it is, not by its offset: typing above a heading moves the offset, and
  // an id that moved with it changed the outline on every keystroke.
  const namesakes = new Map<string, number>();

  const walk = (path: string, depth: number) => {
    const source = sources[path];
    if (depth > maxDepth || visiting.has(path) || source == null) return;
    visiting.add(path);
    // One line counter per source, so nested includes cannot disturb the parent's position.
    const lineAt = lineCounter(source);
    for (const event of outlineEvents(source)) {
      if (event.kind === "appendix") {
        inAppendix = true;
        continue;
      }
      if (event.kind === "section") {
        const name = `${path}:${event.level}:${event.title}`;
        const namesake = namesakes.get(name) ?? 0;
        namesakes.set(name, namesake + 1);
        const node: OutlineNode = {
          id: `${name}#${namesake}`,
          level: event.level,
          title: event.title,
          line: lineAt(event.offset),
          path,
          kind: "section",
          ...(event.starred ? { starred: true as const } : {}),
          ...(inAppendix ? { appendix: true as const } : {}),
          children: [],
        };
        while (stack.length && stack[stack.length - 1].level >= event.level) stack.pop();
        (stack.length ? stack[stack.length - 1].children : roots).push(node);
        stack.push(node);
        continue;
      }
      const included = resolveTexPath(event.raw, projectPaths);
      if (!included || !(included in sources)) continue;
      const previousStack = [...stack];
      // Keep included sections under the current semantic parent without adding
      // a visible file node. The frame prevents section levels in the included
      // source from popping that parent.
      stack.push({
        id: `${path}:input-frame:${event.offset}:${included}`,
        level: 0 as OutlineLevel,
        title: "",
        line: 0,
        path: included,
        children: stack.length ? stack[stack.length - 1].children : roots,
      });
      walk(included, depth + 1);
      stack.splice(0, stack.length, ...previousStack);
    }
    visiting.delete(path);
  };

  walk(rootPath, 0);
  return roots;
}
