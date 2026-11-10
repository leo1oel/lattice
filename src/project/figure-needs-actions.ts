/**
 * A figure's entry file changed (its drawing was saved with compound numbers,
 * say): the root documents that include it get the packages and definitions
 * it now needs, as a paste would have added them. Loaded only when an entry
 * changes; figure-converters.ts watches.
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { includedTexPaths, preambleFiles } from "../editor/insert/editable-figure";
import { completePreamble, figureNeedsOf } from "../editor/insert/figure-needs";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";

/** How deep `\input` chains are followed, and how many files are read, looking for the entry. */
const MAX_INCLUDE_DEPTH = 4;
const MAX_FILES_READ = 64;

type Read = (path: string) => Promise<string>;

/** Whether the document at `path` brings in `entry`, itself or through the files it includes. */
export async function includesEntry(path: string, text: string, entry: string, read: Read): Promise<boolean> {
  const seen = new Set([path]);
  let level: { path: string; text: string }[] = [{ path, text }];
  for (let depth = 0; depth <= MAX_INCLUDE_DEPTH && level.length; depth += 1) {
    const next: string[] = [];
    for (const file of level) {
      for (const line of file.text.split("\n")) {
        if (!line.includes("\\")) continue;
        const named = includedTexPaths(line, file.path);
        if (named.includes(entry)) return true;
        for (const candidate of named) if (!seen.has(candidate) && seen.size < MAX_FILES_READ) { seen.add(candidate); next.push(candidate); }
      }
    }
    const texts = await Promise.all(next.map((candidate) => read(candidate).then((body) => ({ path: candidate, text: body }), () => null)));
    level = texts.filter((file): file is { path: string; text: string } => file !== null);
  }
  return false;
}

/**
 * The text of the files a root document's preamble loads. TeX reads them from
 * the root's folder first, then (a root in a subfolder) the project's.
 */
async function knownText(rootPath: string, rootText: string, read: Read): Promise<string> {
  const folder = rootPath.slice(0, rootPath.lastIndexOf("/") + 1);
  const texts = await Promise.all(preambleFiles(rootText).map(async (path) => {
    for (const candidate of folder ? [`${folder}${path}`, path] : [path]) {
      const text = await read(candidate).catch(() => null);
      if (text !== null) return text;
    }
    return "";
  }));
  return texts.join("\n");
}

/** Adds to each root document that includes `entryPath` what the entry now needs and it lacks. */
export async function completeFigureNeeds(entryPath: string, entryText: string, projectRoot: string, rootDocuments: readonly string[]): Promise<void> {
  const needs = figureNeedsOf(entryText);
  if (!needs) return;
  const read: Read = (path) => invoke<string>("read_project_file", { path, projectRoot });
  for (const rootPath of rootDocuments) {
    const rootText = await read(rootPath).catch(() => null);
    if (rootText === null || !(await includesEntry(rootPath, rootText, entryPath, read))) continue;
    const known = await knownText(rootPath, rootText, read);
    const { text, added, withheld, unlisted } = completePreamble(rootText, known, entryPath, needs);
    if (text !== null) {
      // A merge, like an editor save, should the document change in between.
      await invoke("write_project_file", { path: rootPath, content: text, projectRoot, baseContent: rootText });
      notifyInfo(i18n._(msg`Figures`), i18n._(msg`Added what ${entryPath} now needs to the preamble of ${rootPath}`), { detail: added.join("\n") });
    }
    if (unlisted) {
      const command = "\\graphicspath";
      notifyInfo(i18n._(msg`Figures`), i18n._(msg`Add ${unlisted} to the ${command} in the preamble of ${rootPath}`), {
        detail: i18n._(msg`${entryPath} finds its drawing there. ${command} is set in a file the preamble loads, so Lattice does not add a second one, which would replace it.`),
        dedupeKey: `figure-needs-path:${entryPath}`,
        timeoutMs: 0,
      });
    }
    if (withheld.length) {
      notifyInfo(i18n._(msg`Figures`), i18n._(msg`${entryPath} asks for lines in the preamble of ${rootPath}`), {
        detail: i18n._(msg`They do more than define commands, so Lattice does not add them. Add them yourself if you trust the figure:`) + "\n\n" + withheld.join("\n"),
        dedupeKey: `figure-needs:${entryPath}`,
        timeoutMs: 0,
      });
    }
  }
}
