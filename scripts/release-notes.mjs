// The in-app "What's new" notes (src/release-notes/<version>.json), written
// from a release's lead (.github/release-notes/v<version>.md) when
// bump-version.mjs bumps to it.
//
// The lead is the maintainer's: "## Highlights since …" with one
// `- **Title.** Body` item per highlight, then "## Notable fixes" with one
// `- …` item per fix. The app shows them in the interface language, so each
// text carries `en` and `zh`; a rewrite keeps the Chinese of every English
// text that did not change, and leaves the rest empty for the maintainer to
// translate (src/release-notes/release-notes.test.ts refuses an empty one).
// A highlight may also name an `icon` (whats-new-dialog.tsx lists them);
// a rewrite keeps it for an unchanged title, and the sheet draws a plain
// sparkle for one without.
//
// Usage: node scripts/release-notes.mjs <version> [YYYY-MM-DD]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Markdown down to the plain text the sheet shows: no emphasis markers or code ticks. */
const plain = (text) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();

/** A lead's highlights and fixes, in English. */
export function parseReleaseLead(markdown) {
  const highlights = [];
  const fixes = [];
  let section = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      section = /^highlights/i.test(heading[1]) ? "highlights" : /fix/i.test(heading[1]) ? "fixes" : null;
      continue;
    }
    const item = /^-\s+(.*)$/.exec(line);
    if (!item || !section) continue;
    if (section === "fixes") {
      fixes.push(plain(item[1]));
      continue;
    }
    // `**Title.** Body`: the bold run is the title, without its closing stop.
    const titled = /^\*\*(.+?)\*\*\s*(.*)$/.exec(item[1]);
    const title = plain(titled ? titled[1] : item[1]).replace(/[.:]$/, "");
    highlights.push({ title, body: titled ? plain(titled[2]) : "" });
  }
  return { highlights, fixes };
}

/** The notes for `version`, keeping `previous`'s Chinese wherever the English is unchanged. */
export function releaseNotes(version, date, lead, previous = null) {
  const zh = new Map();
  const icons = new Map();
  const remember = (text) => { if (text?.en && text.zh) zh.set(text.en, text.zh); };
  for (const note of previous?.highlights ?? []) {
    remember(note.title);
    remember(note.body);
    if (note.icon) icons.set(note.title.en, note.icon);
  }
  for (const fix of previous?.fixes ?? []) remember(fix);
  const bilingual = (en) => ({ en, zh: zh.get(en) ?? "" });
  return {
    version,
    date,
    highlights: lead.highlights.map(({ title, body }) => ({
      ...(icons.has(title) ? { icon: icons.get(title) } : {}),
      title: bilingual(title),
      ...(body ? { body: bilingual(body) } : {}),
    })),
    fixes: lead.fixes.map(bilingual),
  };
}

/**
 * Write src/release-notes/<version>.json from its lead. Returns the path and
 * how many texts still need Chinese, or null when the release has no lead.
 */
export function writeReleaseNotes(version, date, root = projectRoot) {
  const leadPath = join(root, ".github/release-notes", `v${version}.md`);
  if (!existsSync(leadPath)) return null;
  const notesPath = join(root, "src/release-notes", `${version}.json`);
  const previous = existsSync(notesPath) ? JSON.parse(readFileSync(notesPath, "utf8")) : null;
  const notes = releaseNotes(version, date, parseReleaseLead(readFileSync(leadPath, "utf8")), previous);
  writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`);
  const texts = [...notes.highlights.flatMap((note) => [note.title, note.body].filter(Boolean)), ...notes.fixes];
  return { path: notesPath, untranslated: texts.filter((text) => !text.zh).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: node scripts/release-notes.mjs <x.y.z> [YYYY-MM-DD]");
  const written = writeReleaseNotes(version, date);
  if (!written) throw new Error(`No .github/release-notes/v${version}.md to write the notes from.`);
  console.log(`Wrote ${written.path}; ${written.untranslated} text(s) need Chinese.`);
}
