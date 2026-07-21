export type OutlineLevel = 1 | 2 | 3 | 4 | 5;

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
const INCLUDE_COMMAND = /\\(?:input|include)\{([^}]*)\}/g;
const LEVELS: Record<string, OutlineLevel> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
};

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

export function resolveIncludePath(raw: string, projectPaths: string[]): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = trimmed.endsWith(".tex") ? [trimmed] : [trimmed, `${trimmed}.tex`];
  for (const candidate of candidates) {
    if (projectPaths.includes(candidate)) return candidate;
    const nested = projectPaths.find((path) => path === candidate || path.endsWith(`/${candidate}`));
    if (nested) return nested;
  }
  return null;
}

export function includedPathsIn(source: string, projectPaths: string[]): string[] {
  const paths: string[] = [];
  INCLUDE_COMMAND.lastIndex = 0;
  for (let match = INCLUDE_COMMAND.exec(source); match; match = INCLUDE_COMMAND.exec(source)) {
    const resolved = resolveIncludePath(match[1], projectPaths);
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const flat: OutlineNode[] = [];
  const walk = (items: OutlineNode[]) => {
    for (const node of items) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return flat;
}

/** Nearest enclosing section nodes for a 1-based line (outer → inner). */
export function sectionBreadcrumbNodes(source: string, line: number, path = ""): OutlineNode[] {
  const flat = flattenOutline(parseLatexOutline(source, path)).filter((node) => node.kind !== "input");
  const best: OutlineNode[] = [];
  for (const node of flat) {
    if (node.line > line) break;
    while (best.length && best[best.length - 1].level >= node.level) best.pop();
    best.push(node);
  }
  return best;
}

/** Nearest enclosing section titles for a 1-based line (outer → inner). */
export function sectionBreadcrumb(source: string, line: number): string[] {
  return sectionBreadcrumbNodes(source, line).map((node) => node.title);
}

/** Innermost section covering path:line in a project outline. */
export function activeOutlineNode(
  nodes: OutlineNode[],
  path: string,
  line: number,
): OutlineNode | null {
  const sections = flattenOutline(nodes)
    .filter((node) => node.kind !== "input" && node.path === path && node.line <= line)
    .sort((left, right) => left.line - right.line || left.level - right.level);
  const best: OutlineNode[] = [];
  for (const node of sections) {
    while (best.length && best[best.length - 1].level >= node.level) best.pop();
    best.push(node);
  }
  return best[best.length - 1] ?? null;
}

export function parseLatexOutline(source: string, path = ""): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  SECTION_COMMAND.lastIndex = 0;
  for (let match = SECTION_COMMAND.exec(source); match; match = SECTION_COMMAND.exec(source)) {
    const command = match[1];
    const level = LEVELS[command];
    if (!level) continue;
    const title = match[2].replace(/\s+/g, " ").trim() || `(${command})`;
    const node: OutlineNode = {
      id: `${path}:${level}:${match.index}:${title}`,
      level,
      title,
      line: lineAt(source, match.index),
      path,
      kind: "section",
      children: [],
    };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (!stack.length) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

type OutlineEvent =
  | { kind: "section"; offset: number; level: OutlineLevel; title: string }
  | { kind: "input"; offset: number; raw: string };

function outlineEvents(source: string): OutlineEvent[] {
  const events: OutlineEvent[] = [];
  SECTION_COMMAND.lastIndex = 0;
  for (let match = SECTION_COMMAND.exec(source); match; match = SECTION_COMMAND.exec(source)) {
    const level = LEVELS[match[1]];
    if (!level) continue;
    events.push({
      kind: "section",
      offset: match.index,
      level,
      title: match[2].replace(/\s+/g, " ").trim() || `(${match[1]})`,
    });
  }
  INCLUDE_COMMAND.lastIndex = 0;
  for (let match = INCLUDE_COMMAND.exec(source); match; match = INCLUDE_COMMAND.exec(source)) {
    events.push({ kind: "input", offset: match.index, raw: match[1] });
  }
  events.sort((left, right) => left.offset - right.offset);
  return events;
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
    if (depth > maxDepth || visiting.has(path)) return;
    const source = sources[path];
    if (source == null) return;
    visiting.add(path);
    for (const event of outlineEvents(source)) {
      if (event.kind === "section") {
        const node: OutlineNode = {
          id: `${path}:${event.level}:${event.offset}:${event.title}`,
          level: event.level,
          title: event.title,
          line: lineAt(source, event.offset),
          path,
          kind: "section",
          children: [],
        };
        while (stack.length && stack[stack.length - 1].level >= event.level) stack.pop();
        if (!stack.length) roots.push(node);
        else stack[stack.length - 1].children.push(node);
        stack.push(node);
        continue;
      }
      const included = resolveIncludePath(event.raw, projectPaths);
      if (!included || !(included in sources)) continue;
      const marker: OutlineNode = {
        id: `${path}:input:${event.offset}:${included}`,
        level: Math.min(5, (stack[stack.length - 1]?.level ?? 2) + 1) as OutlineLevel,
        title: included,
        line: lineAt(source, event.offset),
        path,
        kind: "input",
        children: [],
      };
      if (!stack.length) roots.push(marker);
      else stack[stack.length - 1].children.push(marker);
      // Share children with a level-0 frame so nested sections don't pop the marker.
      const stackDepth = stack.length;
      stack.push({
        id: `${marker.id}:frame`,
        level: 0 as OutlineLevel,
        title: "",
        line: 0,
        path: included,
        children: marker.children,
      });
      walk(included, depth + 1);
      stack.length = stackDepth;
    }
    visiting.delete(path);
  };

  walk(rootPath, 0);
  return roots;
}
