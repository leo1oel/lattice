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
  children: OutlineNode[];
};

const SECTION_COMMAND = /\\(part|chapter|section|subsection|subsubsection)\*?\{([^{}]*)\}/g;
const LEVELS: Record<string, OutlineLevel> = { part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5 };

export function includedPathsIn(source: string, projectPaths: string[]): string[] {
  const paths = [...source.matchAll(INCLUDE)].map((match) => resolveTexPath(match[1], projectPaths));
  return [...new Set(paths.filter((path): path is string => path !== null))];
}

export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutline(node.children)]);
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

/** The section tree of a single file (includes are not followed). */
export function parseLatexOutline(source: string, path = ""): OutlineNode[] {
  return parseProjectOutline(path, { [path]: source }, []);
}

type OutlineEvent =
  | { kind: "section"; offset: number; level: OutlineLevel; title: string }
  | { kind: "input"; offset: number; raw: string };

function outlineEvents(source: string): OutlineEvent[] {
  const sections = [...source.matchAll(SECTION_COMMAND)].map((match): OutlineEvent => ({
    kind: "section",
    offset: match.index,
    level: LEVELS[match[1]],
    title: match[2].replace(/\s+/g, " ").trim() || `(${match[1]})`,
  }));
  const inputs = [...source.matchAll(INCLUDE)].map((match): OutlineEvent => ({
    kind: "input",
    offset: match.index,
    raw: match[1],
  }));
  return [...sections, ...inputs].sort((left, right) => left.offset - right.offset);
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

  const walk = (path: string, depth: number) => {
    const source = sources[path];
    if (depth > maxDepth || visiting.has(path) || source == null) return;
    visiting.add(path);
    // One line counter per source, so nested includes cannot disturb the parent's position.
    const lineAt = lineCounter(source);
    for (const event of outlineEvents(source)) {
      if (event.kind === "section") {
        const node: OutlineNode = {
          id: `${path}:${event.level}:${event.offset}:${event.title}`,
          level: event.level,
          title: event.title,
          line: lineAt(event.offset),
          path,
          kind: "section",
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
