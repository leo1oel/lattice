/**
 * Reads THIRD_PARTY_NOTICES.md, which ships with the app, back into the list
 * Settings › About › Acknowledgements shows.
 *
 * That file is the one source of truth for what Lattice distributes: its
 * generated half (`scripts/generate-notices.mjs`) lists every package of the
 * four closures the app bundle carries, grouped by the license text that
 * governs them, and `pnpm notices:check` keeps it in step with the lockfiles.
 * Parsing it here, rather than keeping a second list, means a dependency the
 * notices cover is one the pane credits, with the same license and version.
 *
 * Only the generated half is read. Within it the license texts sit in fenced
 * code blocks, and some of them are Markdown documents with headings of their
 * own, so fences are tracked and nothing inside one is taken for structure.
 */

export type ThirdPartyClosure = "npm" | "crates" | "sidecar" | "presentation-runtime";

export type ThirdPartyPackage = {
  closure: ThirdPartyClosure;
  name: string;
  version: string;
  /** The declared license of the text that governs it, as the notices name it. */
  license: string;
};

/** One reproduced license text and the notices that share it. */
type LicenseGroup = {
  closure: ThirdPartyClosure;
  /** Its heading, e.g. "MIT — 254 package(s), from LICENSE". */
  title: string;
  /** `name@version` of every package it governs. */
  packages: readonly string[];
  /** The copyright notices that share the text, when any were found, then the text itself. */
  copyrights: string | null;
  text: string;
};

export type ThirdPartyNotices = {
  packages: readonly ThirdPartyPackage[];
  groups: readonly LicenseGroup[];
};

// eslint-disable-next-line lingui/no-unlocalized-strings -- marker the generator writes
const BEGIN = "<!-- BEGIN GENERATED NOTICES";

/** Each closure section's heading, as the generator titles it. */
const CLOSURE_HEADINGS: ReadonlyArray<readonly [RegExp, ThirdPartyClosure]> = [
  [/^## npm packages\b/, "npm"],
  [/^## Rust crates\b/, "crates"],
  [/^## Synara agent sidecar\b/, "sidecar"],
  [/^## Open Slide presentation runtime\b/, "presentation-runtime"],
];
const CLOSURES = new Set<string>(CLOSURE_HEADINGS.map(([, closure]) => closure));

// "#### 1. MIT (+1 other declarations) — 254 package(s), from `LICENSE`"
const GROUP_HEADING = /^#### \d+\. (.+?)(?: \(\+\d+ other declarations?\))? — (\d+ package\(s\), from .+)$/;
// "- `unicount@1.1.0` (npm) — declared `ISC`", or without the declaration when
// the package has no `license` field at all.
const UNRESOLVED_ITEM = /^- `([^`]+)` \(([a-z-]+)\)(?: — declared `([^`]+)`)?/;
// "`name@1.0.0`", or "`name@1.0.0` (`Apache-2.0`)" when the package declares
// something other than its group's leading declaration. Sections generated
// before that annotation existed (a staged runtime's, carried over) list bare
// names, and their packages take the group's label.
const PACKAGE_ITEM = /`([^`]+)`(?: \(`([^`]+)`\))?/g;
const FENCE = /^(`{3,})/;
// eslint-disable-next-line lingui/no-unlocalized-strings -- the generator's placeholder, read back
const NO_LICENSE_FIELD = "(no license field)";
const licenseOf = (declared: string) => (declared === NO_LICENSE_FIELD ? "" : declared);

/** `@scope/name@1.2.3` → its name and version; the version follows the last `@`. */
export function splitPackageId(id: string): { name: string; version: string } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

export function parseThirdPartyNotices(markdown: string): ThirdPartyNotices {
  const start = markdown.indexOf(BEGIN);
  const lines = start === -1 ? [] : markdown.slice(start).split("\n");

  const groups: LicenseGroup[] = [];
  // closure → package id → license
  const licenses = new Map<ThirdPartyClosure, Map<string, string>>();
  const record = (closure: ThirdPartyClosure, id: string, license: string) => {
    let byId = licenses.get(closure);
    if (!byId) licenses.set(closure, byId = new Map());
    // A package under several texts (LICENSE-MIT and LICENSE-APACHE) declares
    // the same thing in each; the first one stands.
    if (!byId.has(id)) byId.set(id, license);
  };
  const unresolved: Array<{ closure: ThirdPartyClosure; id: string; license: string }> = [];

  let closure: ThirdPartyClosure | null = null;
  let group: (LicenseGroup & { label: string; packages: string[] }) | null = null;
  let fence: { marker: string; lines: string[] } | null = null;
  // The generator introduces a group's notices with "Copyright notices (N):"
  // and follows them with the text, so the fence after that line holds them.
  let copyrightsNext = false;

  for (const line of lines) {
    if (fence) {
      if (line.startsWith(fence.marker) && line.slice(fence.marker.length).trim() === "") {
        const block = fence.lines.join("\n");
        if (group && copyrightsNext) group.copyrights = block;
        else if (group && !group.text) group.text = block;
        copyrightsNext = false;
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening) {
      fence = { marker: opening[1], lines: [] };
      continue;
    }
    if (/^Copyright notices \(\d+\):$/.test(line)) {
      copyrightsNext = true;
      continue;
    }
    if (line.startsWith("## ")) {
      closure = CLOSURE_HEADINGS.find(([heading]) => heading.test(line))?.[1] ?? closure;
      group = null;
      continue;
    }
    const heading = GROUP_HEADING.exec(line);
    if (heading && closure) {
      group = { closure, label: licenseOf(heading[1]), title: `${heading[1]} — ${heading[2].replaceAll("`", "")}`, packages: [], copyrights: null, text: "" };
      groups.push(group);
      continue;
    }
    if (line.startsWith("#")) {
      group = null;
      continue;
    }
    if (group && group.packages.length === 0 && line.startsWith("`")) {
      for (const [, id, declared] of line.matchAll(PACKAGE_ITEM)) {
        if (!splitPackageId(id)) continue;
        group.packages.push(id);
        record(group.closure, id, declared === undefined ? group.label : licenseOf(declared));
      }
      continue;
    }
    // A package with no license text appears in no group, only in the
    // unresolved lists, which name the closure on each line.
    const item = UNRESOLVED_ITEM.exec(line);
    if (item && CLOSURES.has(item[2])) {
      unresolved.push({ closure: item[2] as ThirdPartyClosure, id: item[1], license: item[3] ?? "" });
    }
  }

  for (const { closure: itemClosure, id, license } of unresolved) {
    if (!licenses.get(itemClosure)?.has(id)) record(itemClosure, id, license);
  }

  const packages: ThirdPartyPackage[] = [];
  for (const [packageClosure, byId] of licenses) {
    for (const [id, license] of byId) {
      const parsed = splitPackageId(id);
      if (parsed) packages.push({ closure: packageClosure, ...parsed, license });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
  return { packages, groups };
}

/** The license texts that govern one package, as the notices reproduce them. */
export const licenseGroupsFor = (notices: ThirdPartyNotices, pkg: ThirdPartyPackage) =>
  notices.groups.filter((group) => group.closure === pkg.closure && group.packages.includes(`${pkg.name}@${pkg.version}`));

/** Where a package is published, for a link out of the list. */
export const packageRegistryUrl = (pkg: Pick<ThirdPartyPackage, "closure" | "name">) =>
  pkg.closure === "crates"
    ? `https://crates.io/crates/${pkg.name}`
    : `https://www.npmjs.com/package/${pkg.name}`;
