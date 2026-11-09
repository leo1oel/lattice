/**
 * Where a compound is drawn: the float (figure, scheme, chart, table) holding
 * the editable-figure entry file that names its key, for the compound lists
 * to say which picture a number comes from.
 */
import type { CompiledLabel } from "./compiled-labels";
import { compoundKeysIn, numberedKey } from "./compound-keys";

export type CompoundSource = { path: string; text: string };
export type CompoundFloat = { environment: string; label?: string; ordinal: number; caption?: string };
export type CompoundPlace = { file: string; float?: CompoundFloat };

const FIGURE_ENTRY = /^% editable-figure source: /;
const FLOAT_EDGE = /\\(begin|end)\{(figure|scheme|chart|graph|table)\*?\}/g;
const INCLUDE = /\\(?:(?:sub)?import\{([^{}]*)\}\{([^{}]*)\}|(?:input|include)\{([^{}]*)\})/g;
const CAPTION_LENGTH = 48;
/** Enough of a caption for its short line; a file's own text must not make the patterns below slow. */
const CAPTION_SCAN = 2000;
/** The uses of one entry file looked at in one source, each needing a pass over that source. */
const MAX_USES = 20;
/** The figure entries a project's list reads. */
const MAX_ENTRIES = 500;

/** The text with its comments blanked, every offset unchanged. */
const withoutComments = (text: string) => text.replace(/(?<!\\)%.*$/gm, (comment) => " ".repeat(comment.length));

/** The balanced group opening at `open`: its content, or null when it never closes. */
export function bracedGroup(text: string, open: number): string | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return text.slice(open + 1, index);
  }
  return null;
}

/** A source with its comments blanked and its float edges, read once for every use in it. */
type ScannedSource = { path: string; text: string; edges: RegExpExecArray[] };

const scanned = (path: string, text: string): ScannedSource => {
  const blank = withoutComments(text);
  return { path, text: blank, edges: [...blank.matchAll(FLOAT_EDGE)] };
};

/** The float open at `position`, with its caption, label and place among floats of its kind in `text`. */
export function enclosingFloat(text: string, position: number): CompoundFloat | undefined {
  return floatAt(scanned("", text), position);
}

function floatAt({ text: source, edges }: ScannedSource, position: number): CompoundFloat | undefined {
  const open: RegExpExecArray[] = [];
  for (const edge of edges) {
    if (edge.index >= position) break;
    if (edge[1] === "begin") open.push(edge);
    else open.pop();
  }
  const begin = open.at(-1);
  if (!begin) return undefined;
  const environment = begin[2];
  const after = edges.find((edge) => edge.index > position && edge[1] === "end" && edge[2] === environment);
  const body = source.slice(begin.index, after?.index);
  const caption = /\\caption(?:\[[^\][{}]*\])?(?=\{)/.exec(body);
  return {
    environment,
    label: /\\label\{([^{}]*)\}/.exec(body)?.[1],
    ordinal: edges.filter((edge) => edge[1] === "begin" && edge[2] === environment && edge.index <= begin.index).length,
    caption: caption ? bracedGroup(body, caption.index + caption[0].length) ?? undefined : undefined,
  };
}

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const normalized = (path: string) => {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
};
const stem = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.tex$/i, "");

type Use = { source: ScannedSource; position: number };

/**
 * Every include command of every source, by the project path it may name:
 * as written, and beside the source. Each source is scanned once, however
 * many figure entries the project has.
 */
function usesByPath(sources: CompoundSource[]): Map<string, Use[]> {
  const uses = new Map<string, Use[]>();
  for (const { path, text } of sources) {
    const source = scanned(path, text);
    const counts = new Map<string, number>();
    for (const match of source.text.matchAll(INCLUDE)) {
      const name = match[3] ?? `${match[1]}/${match[2]}`;
      const file = /\.tex$/i.test(name) ? name : `${name}.tex`;
      for (const target of new Set([normalized(file), normalized(`${directoryOf(path)}${file}`)])) {
        const count = counts.get(target) ?? 0;
        if (count >= MAX_USES) continue;
        counts.set(target, count + 1);
        const list = uses.get(target) ?? [];
        list.push({ source, position: match.index });
        uses.set(target, list);
      }
    }
  }
  return uses;
}

/** Each key drawn in a figure, placed by the first float that includes it, or by its file when none does. */
export function compoundPlaces(sources: CompoundSource[]): Map<string, CompoundPlace> {
  const places = new Map<string, CompoundPlace & { position: number }>();
  const usesOf = usesByPath(sources);
  for (const entry of sources.filter((source) => FIGURE_ENTRY.test(source.text)).slice(0, MAX_ENTRIES)) {
    const uses = (usesOf.get(normalized(entry.path)) ?? [])
      .map(({ source, position }) => ({ position, float: floatAt(source, position) }));
    const use = uses.find(({ float }) => float) ?? uses[0];
    const place = { file: stem(entry.path), float: use?.float, position: use?.position ?? Number.MAX_SAFE_INTEGER };
    for (const key of compoundKeysIn([entry.text])) {
      const known = places.get(key);
      const better = !known || (Boolean(place.float) !== Boolean(known.float) ? Boolean(place.float) : place.position < known.position);
      if (better) places.set(key, place);
    }
  }
  return places;
}

/** A caption as plain text: compounds as their numbers, markup gone, cut to a short line. */
export function captionLine(caption: string, numbers: ReadonlyMap<string, string>): string {
  const line = caption.slice(0, CAPTION_SCAN)
    .replace(/\\(?:cmpd\*?|refcmpd)(?:\[[^\][{}]*\])?\{([^{}]*)\}/g, (_, keys: string) => (
      keys.split(",").map((key) => numbers.get(key.trim()) ?? key.trim()).join(", ")
    ))
    .replace(/\\rcmpd\{([^{}]*)\}/g, (_, mark: string) => numbers.get(numberedKey(mark.trim())) ?? mark.trim())
    .replace(/\\(?:label|cite[a-z]*|ref)\{[^{}]*\}/g, "")
    .replace(/\\[A-Za-z@]+\*?/g, "")
    .replace(/[{}$~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > CAPTION_LENGTH ? `${line.slice(0, CAPTION_LENGTH).trimEnd()}…` : line;
}

/**
 * "Scheme 1: Reduction of…" for a compound's place. The number is the one the
 * last build gave the float's label, or else its count among floats of its
 * kind in the file including it. Without a build, the kind and the file name.
 */
export function placeLine(
  place: CompoundPlace, labels: ReadonlyMap<string, CompiledLabel> | null, numbers: ReadonlyMap<string, string>,
): string {
  const { float, file } = place;
  if (!float) return file;
  const kind = float.environment[0].toUpperCase() + float.environment.slice(1);
  if (!labels) return `${kind} · ${file}`;
  const head = `${kind} ${(float.label && labels.get(float.label)?.number) || float.ordinal}`;
  return float.caption ? `${head}: ${captionLine(float.caption, numbers)}` : head;
}
