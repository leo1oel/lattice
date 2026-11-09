/** What the last build numbered each label, read from the `.aux` files it wrote. */
import { invoke } from "@tauri-apps/api/core";

export type CompiledLabel = { number: string; page: string };

/** The build whose `.aux` is read; a new build is a new object, and reads it again. */
export type CompiledBuild = { rootDocument: string };

/** The brace-balanced group that opens at `from`, and the offset just past it. */
function group(text: string, from: number): [content: string, end: number] | null {
  if (text[from] !== "{") return null;
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return [text.slice(from + 1, index), index + 1];
  }
  return null;
}

/** A number or page as TeX wrote it (`{\relax 3}`, `{\textup {(3)}}`), without its markup. */
const plain = (value: string) => value.replace(/\\[A-Za-z@]+\s*/g, "").replace(/[{}]/g, "").trim();

/**
 * `\newlabel{key}{{number}{page}…}` lines, and the chapter `.aux` files an
 * `\include` adds through `\@input{…}`. cleveref's `key@cref` twins are not
 * labels the writer typed.
 */
export function parseAux(aux: string): { labels: Map<string, CompiledLabel>; inputs: string[] } {
  const labels = new Map<string, CompiledLabel>();
  for (const match of aux.matchAll(/\\newlabel\{([^}]*)\}/g)) {
    const key = match[1];
    const outer = group(aux, match.index + match[0].length);
    const number = outer && group(outer[0], 0);
    const page = outer && number && group(outer[0], number[1]);
    if (key.endsWith("@cref") || !number || !page) continue;
    labels.set(key, { number: plain(number[0]), page: plain(page[0]) });
  }
  return { labels, inputs: [...aux.matchAll(/\\@input\{([^}]+\.aux)\}/g)].map((match) => match[1]) };
}

/** A document's chapters read for their numbers: the `.aux` is the build's output, so it is bounded too. */
const MAX_AUX_INPUTS = 300;
/** A document can write anything to its `.aux`; a longer one is read as empty, numbering nothing. */
const MAX_AUX_CHARS = 4_000_000;

/** The text of the last build's `.aux` files: the root document's, beside it, and each chapter's it names. */
export async function compiledAuxTexts(projectRoot: string | undefined, build: CompiledBuild): Promise<string[]> {
  const directory = build.rootDocument.includes("/") ? build.rootDocument.replace(/[^/]*$/, "") : "";
  const read = (path: string) => invoke<string>("read_project_file", { path, projectRoot })
    .then((text) => (text.length > MAX_AUX_CHARS ? "" : text), () => "");
  const main = await read(build.rootDocument.replace(/\.tex$/i, ".aux"));
  return [main, ...await Promise.all(parseAux(main).inputs.slice(0, MAX_AUX_INPUTS).map((path) => read(`${directory}${path}`)))];
}

let cache: { root: string | undefined; build: CompiledBuild; labels: Promise<Map<string, CompiledLabel>> } | null = null;

/** The last build's label numbers and pages, read once per build. A project never built numbers nothing. */
export function compiledLabels(projectRoot: string | undefined, build: CompiledBuild): Promise<Map<string, CompiledLabel>> {
  if (cache && cache.root === projectRoot && cache.build === build) return cache.labels;
  const labels = compiledAuxTexts(projectRoot, build)
    .then((texts) => new Map(texts.flatMap((text) => [...parseAux(text).labels])));
  cache = { root: projectRoot, build, labels };
  return labels;
}
