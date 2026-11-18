#!/usr/bin/env node
// The plugin API only grows. Compares every committed
// plugin-api/schema/level-<N>.json with the same file at a base revision
// (default origin/main), and each level with the level below it, and fails
// when anything a plugin could rely on was removed or narrowed:
//
// - a method, a $defs type, a property, an enum value or a union variant
//   disappeared;
// - a method changed direction or `since`, or a property changed type;
// - a property became required (old plugins and hosts do not send it).
//
// The Rust side (lattice-core plugins::schema) keeps the file equal to the
// protocol types; this keeps the file additive. The contract is
// docs/plugins.md, "Compatibility".
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SCHEMA_DIR = "plugin-api/schema";

/** Every way `head` fails to be a superset of `base`, as readable lines. */
export function additiveProblems(base, head) {
  const problems = [];
  const def = (doc, ref) => doc.$defs?.[ref.replace("#/$defs/", "")];
  const seen = new Set();

  function compare(b, h, where) {
    if (!b || typeof b !== "object") return;
    if (!h || typeof h !== "object") {
      problems.push(`${where}: removed`);
      return;
    }
    if (b.$ref) {
      if (h.$ref !== b.$ref) {
        problems.push(`${where}: was ${b.$ref}, now ${h.$ref ?? "an inline schema"}`);
        return;
      }
      if (!seen.has(b.$ref)) {
        seen.add(b.$ref);
        compare(def(base, b.$ref), def(head, h.$ref), b.$ref);
      }
      return;
    }
    const types = (s) => (s.type === undefined ? null : [s.type].flat());
    const [bt, ht] = [types(b), types(h)];
    if (bt && (!ht || !bt.every((t) => ht.includes(t)))) {
      problems.push(`${where}: type ${bt.join("|")} became ${ht ? ht.join("|") : "untyped"}`);
    }
    if (b.const !== undefined && JSON.stringify(b.const) !== JSON.stringify(h.const)) {
      problems.push(`${where}: const ${JSON.stringify(b.const)} changed`);
    }
    for (const value of b.enum ?? []) {
      if (!(h.enum ?? []).some((v) => JSON.stringify(v) === JSON.stringify(value))) {
        problems.push(`${where}: enum value ${JSON.stringify(value)} removed`);
      }
    }
    for (const [name, schema] of Object.entries(b.properties ?? {})) {
      compare(schema, h.properties?.[name], `${where}.${name}`);
    }
    const wasRequired = new Set(b.required ?? []);
    for (const name of h.required ?? []) {
      if (!wasRequired.has(name)) problems.push(`${where}.${name}: became required`);
    }
    for (const key of ["items", "additionalProperties"]) {
      if (typeof b[key] === "object") compare(b[key], h[key], `${where}[${key}]`);
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      const variants = h[key] ?? [];
      (b[key] ?? []).forEach((variant, index) => {
        const tag = variantTag(variant);
        const match = tag ? variants.find((v) => variantTag(v) === tag) : variants[index];
        compare(variant, match, `${where}.${key}[${tag ?? index}]`);
      });
    }
  }

  for (const [name, method] of Object.entries(base.methods ?? {})) {
    const next = head.methods?.[name];
    if (!next) {
      problems.push(`method ${name}: removed`);
      continue;
    }
    for (const key of ["direction", "since", "notification"]) {
      if (method[key] !== next[key]) problems.push(`method ${name}: ${key} changed`);
    }
    compare(method.params, next.params, `${name} params`);
    if (method.result) compare(method.result, next.result, `${name} result`);
  }
  compare(base.manifest, head.manifest, "manifest");
  for (const name of Object.keys(base.$defs ?? {})) {
    if (!head.$defs?.[name]) problems.push(`#/$defs/${name}: removed`);
    else compare({ $ref: `#/$defs/${name}` }, { $ref: `#/$defs/${name}` }, name);
  }
  for (const [name, code] of Object.entries(base.errorCodes ?? {})) {
    if (head.errorCodes?.[name] !== code) problems.push(`error code ${name}: changed`);
  }
  if ((head.apiCompat ?? 0) > (base.apiCompat ?? 0)) {
    problems.push("apiCompat rose: a level was dropped; that needs the deprecation process");
  }
  return problems;
}

/** The discriminator a tagged-enum variant carries (`kind`/`type` const). */
function variantTag(schema) {
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    if (property?.const !== undefined) return `${name}=${property.const}`;
  }
  return null;
}

function levels(files) {
  return files
    .map((f) => /^level-(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function main() {
  const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" } } });
  const errors = [];
  const headLevels = existsSync(SCHEMA_DIR) ? levels(readdirSync(SCHEMA_DIR)) : [];
  const read = (level) => JSON.parse(readFileSync(join(SCHEMA_DIR, `level-${level}.json`), "utf8"));
  const atBase = (level) => {
    try {
      return JSON.parse(
        execFileSync("git", ["show", `${values.base}:${SCHEMA_DIR}/level-${level}.json`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      return null;
    }
  };
  let baseLevels = [];
  try {
    const listing = execFileSync("git", ["ls-tree", "--name-only", `${values.base}:${SCHEMA_DIR}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    baseLevels = levels(listing.split("\n"));
  } catch {
    // The base predates the plugin API: nothing to compare against.
  }
  for (const level of baseLevels) {
    if (!headLevels.includes(level)) {
      errors.push(`level-${level}.json was deleted; published levels stay`);
      continue;
    }
    for (const p of additiveProblems(atBase(level), read(level))) errors.push(`level ${level} vs ${values.base}: ${p}`);
  }
  headLevels.forEach((level, i) => {
    if (i === 0) return;
    for (const p of additiveProblems(read(headLevels[i - 1]), read(level))) {
      errors.push(`level ${level} vs level ${headLevels[i - 1]}: ${p}`);
    }
  });
  if (errors.length) {
    console.error("The plugin API schema lost or narrowed something (docs/plugins.md, Compatibility):");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`Plugin API schema is additive (levels ${headLevels.join(", ") || "none"} against ${values.base}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
