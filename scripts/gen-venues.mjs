// Generate src/venues.ts — a snapshot of bibcite's canonical venue list used by
// the bibliography-entry editor's venue autocomplete. The venue's category
// decides the BibTeX entry type (journal -> @article, conference/workshop ->
// @inproceedings), so picking a venue can set the type automatically.
//
// Usage: node scripts/gen-venues.mjs [path/to/bibcite]
//   defaults to the sibling ../bibcite checkout.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bibcite = process.argv[2] || resolve(root, "..", "bibcite");
const stringsPath = resolve(bibcite, "src", "bibcite", "data", "strings.bib");
const venuesPyPath = resolve(bibcite, "src", "bibcite", "venues.py");

// Pull `"key": "value"` pairs out of a `NAME = { … }` block in venues.py so the
// aliases/overrides stay in sync with bibcite instead of being hand-copied.
function pyDict(source, name) {
  const block = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  const out = {};
  if (!block) return out;
  for (const [, k, v] of block[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) out[k] = v;
  return out;
}

const stringsText = readFileSync(stringsPath, "utf8");
const venuesPy = readFileSync(venuesPyPath, "utf8");
const CATEGORY_OVERRIDES = pyDict(venuesPy, "CATEGORY_OVERRIDES"); // macro -> category
const EXTRA_ALIASES = pyDict(venuesPy, "EXTRA_ALIASES"); // phrase -> macro

const HEADER = /%{2,}\s*(Journals|Conferences|Workshops)/i;
const STRING = /@string\{(\w+)\s*=\s*"([^"]+)"\}/i;

const aliasesByMacro = new Map();
for (const [phrase, macro] of Object.entries(EXTRA_ALIASES)) {
  if (!aliasesByMacro.has(macro)) aliasesByMacro.set(macro, []);
  aliasesByMacro.get(macro).push(phrase);
}

const norm = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

let category = "journal";
const byName = new Map();
for (const line of stringsText.split("\n")) {
  const header = HEADER.exec(line);
  if (header) {
    category = header[1].toLowerCase().replace(/s$/, ""); // journals -> journal
    continue;
  }
  const match = STRING.exec(line);
  if (!match) continue;
  const [, macro, name] = match;
  const cat = CATEGORY_OVERRIDES[macro] || category;
  const entryType = cat === "journal" ? "article" : "inproceedings";
  const parts = [macro, name, ...(aliasesByMacro.get(macro) || [])];
  const existing = byName.get(name);
  if (existing) existing.parts.push(...parts);
  else byName.set(name, { name, entryType, parts });
}

const venues = [...byName.values()]
  .map((v) => ({ name: v.name, entryType: v.entryType, search: norm(v.parts.join(" ")) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const out = `// Snapshot of bibcite's canonical venues (${venues.length} entries), used by the
// bibliography-entry editor's venue autocomplete. The category from bibcite sets
// the entry type: journal -> @article, conference/workshop -> @inproceedings.
//
// Generated from bibcite's data/strings.bib — regenerate with:
//   node scripts/gen-venues.mjs [path/to/bibcite]
// Do not edit by hand.

export type Venue = { name: string; entryType: "article" | "inproceedings"; search: string };

export const VENUES: Venue[] = ${JSON.stringify(venues, null, 2)};
`;

writeFileSync(resolve(root, "src", "venues.ts"), out);
console.log(`wrote src/venues.ts — ${venues.length} venues from ${stringsPath}`);
