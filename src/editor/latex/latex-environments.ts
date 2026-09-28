import type { Text } from "@codemirror/state";
import { uncommented } from "./latex-language";

const BEGIN_OR_END = /\\(begin|end)\{([A-Za-z*][A-Za-z0-9*]*)\}/g;

type Span = { from: number; to: number };
export type EnvironmentEvent = Span & { kind: "begin" | "end"; name: string };
type EnvironmentPair = { name: string; begin: Span; end: Span };

export function environmentEvents(text: string): EnvironmentEvent[] {
  return [...text.matchAll(BEGIN_OR_END)].map((match) => ({
    kind: match[1] as EnvironmentEvent["kind"],
    name: match[2],
    from: match.index,
    to: match.index + match[0].length,
  }));
}

/** The `\begin{…}` or `\end{…}` delimiter under `position`. */
export function environmentAt(text: string, position: number): EnvironmentEvent | null {
  return environmentEvents(text).find((event) => position >= event.from && position < event.to) ?? null;
}

/** Innermost \\begin/\\end pair that contains position (including the delimiters). */
export function enclosingEnvironment(text: string, position: number): EnvironmentPair | null {
  const stack: EnvironmentEvent[] = [];
  for (const event of environmentEvents(text)) {
    if (event.kind === "begin") {
      stack.push(event);
      continue;
    }
    const open = stack.pop();
    // Innermost pairs close first while scanning left-to-right.
    if (open?.name === event.name && position >= open.from && position <= event.to) {
      return { name: open.name, begin: open, end: event };
    }
  }
  return null;
}

export function enclosingEnvironmentRange(text: string, position: number): Span | null {
  const env = enclosingEnvironment(text, position);
  return env && { from: env.begin.from, to: env.end.to };
}

/** The pair whose `\begin` or `\end` is under the cursor, else the innermost enclosing one. */
function environmentPair(text: string, position: number): EnvironmentPair | null {
  const current = environmentAt(text, position);
  if (!current) return enclosingEnvironment(text, position);
  const forward = current.kind === "begin";
  const candidates = environmentEvents(text).filter((event) =>
    event.name === current.name && (forward ? event.from >= current.from : event.to <= current.to));
  if (!forward) candidates.reverse();
  let depth = 0;
  for (const event of candidates) {
    depth += event.kind === current.kind ? 1 : -1;
    if (depth === 0) return { name: current.name, begin: forward ? current : event, end: forward ? event : current };
  }
  return null;
}

/** The partner of the delimiter under the cursor, else the innermost enclosing `\begin`. */
export function matchingEnvironmentTarget(text: string, position: number): Span | null {
  const pair = environmentPair(text, position);
  if (!pair) return null;
  const { from, to } = position >= pair.begin.from && position < pair.begin.to ? pair.end : pair.begin;
  return { from, to };
}

export function renameEnvironmentAt(
  text: string,
  position: number,
  newName: string,
): { from: number; to: number; insert: string }[] | null {
  const name = newName.trim();
  const pair = name ? environmentPair(text, position) : null;
  if (!pair) return null;
  return [
    { from: pair.begin.from, to: pair.begin.to, insert: `\\begin{${name}}` },
    { from: pair.end.from, to: pair.end.to, insert: `\\end{${name}}` },
  ];
}

/**
 * The body line and `\\end{…}` to add after a just-completed `\\begin{…}` that
 * ends `textBeforeCursor`, with the caret on the body line; `indent` is the
 * `\\begin` line's own indentation. Nothing is added unless `doc`, ignoring
 * `%` comments, has more `\\begin{…}` than `\\end{…}` of that name.
 */
export function beginEnvironmentClose(
  textBeforeCursor: string,
  doc: Text,
  indent = "",
): { insert: string; cursorOffset: number } | null {
  const name = /\\begin\{([A-Za-z*][A-Za-z0-9*]*)\}$/.exec(textBeforeCursor)?.[1];
  if (!name || !isUnbalanced(name, doc)) return null;
  return { insert: `\n${indent}  \n${indent}\\end{${name}}`, cursorOffset: 3 + indent.length };
}

function isUnbalanced(name: string, doc: Text): boolean {
  let open = 0;
  for (const line of doc.iterLines()) {
    if (!line.includes(name)) continue;
    for (const event of environmentEvents(uncommented(line))) {
      if (event.name === name) open += event.kind === "begin" ? 1 : -1;
    }
  }
  return open > 0;
}
