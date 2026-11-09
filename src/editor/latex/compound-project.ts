/** What the project knows about its compounds: read from its `.tex` files and the last build's `.aux`. */
import { invoke } from "@tauri-apps/api/core";
import { compiledAuxTexts, parseAux, type CompiledBuild, type CompiledLabel } from "./compiled-labels";
import { parseCompoundNumbers } from "./compound-keys";
import { compoundPlaces, placeLine, type CompoundSource } from "./compound-places";

/** How many of a project's `.tex` files a compound list reads. */
const MAX_SOURCES = 300;
/** A longer `.tex` file is not a source anyone writes compounds in by hand. */
const MAX_SOURCE_CHARS = 2_000_000;

export type CompoundProject = {
  sources: CompoundSource[];
  numbers: Map<string, string>;
  /** Each drawn key's "Scheme 1: …" line. */
  placeLines: Map<string, string>;
};

let numbersCache: { root: string | undefined; build: CompiledBuild; numbers: Promise<Map<string, string>> } | null = null;

/**
 * What chemnum numbered in the last build, read once per build. Empty for a
 * project that does not use chemnum, which is how the PDF knows to look for
 * no compound at all.
 */
export function compiledCompoundNumbers(projectRoot: string | undefined, build: CompiledBuild): Promise<Map<string, string>> {
  if (numbersCache && numbersCache.root === projectRoot && numbersCache.build === build) return numbersCache.numbers;
  const numbers = compiledAuxTexts(projectRoot, build).then((texts) => parseCompoundNumbers(texts.join("\n")));
  numbersCache = { root: projectRoot, build, numbers };
  return numbers;
}

export async function readCompoundProject(
  projectPaths: readonly string[], projectRoot: string | undefined, build: CompiledBuild | undefined,
): Promise<CompoundProject> {
  const paths = projectPaths.filter((path) => path.endsWith(".tex")).slice(0, MAX_SOURCES);
  const [sources, auxTexts] = await Promise.all([
    Promise.all(paths.map((path) => invoke<string>("read_project_file", { path, projectRoot })
      .then((text) => ({ path, text: text.length > MAX_SOURCE_CHARS ? "" : text }), () => ({ path, text: "" })))),
    build ? compiledAuxTexts(projectRoot, build) : [],
  ]);
  const numbers = parseCompoundNumbers(auxTexts.join("\n"));
  const labels: Map<string, CompiledLabel> | null = build ? new Map(auxTexts.flatMap((aux) => [...parseAux(aux).labels])) : null;
  const placeLines = new Map([...compoundPlaces(sources)].map(([key, place]) => [key, placeLine(place, labels, numbers)]));
  return { sources, numbers, placeLines };
}
