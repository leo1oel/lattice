#!/usr/bin/env node
/**
 * Keeps docs/performance.md's benchmark tables reproducible from what the
 * repository retains. Twice a published table outlived the driver and the raw
 * runs behind it, and review could neither re-derive nor challenge it; this
 * check makes a table carry its evidence when it lands, not after a reviewer
 * asks for it.
 *
 * docs/performance-data/manifest.json accounts for every Markdown table in
 * the documents it lists, matched by section heading and header row:
 *
 *   measured   a benchmark table. It names the before and after commits, the
 *              exact command, fixture, engine and Node versions, viewport, run
 *              count and order, what each figure means and how runs are
 *              aggregated, and the raw runs file. Its rows say which figures
 *              each cell holds; the check recomputes every cell from the raw
 *              runs, with the driver's own figure definitions (`figures`, a
 *              module exporting readFigure(run, name)), and fails on any cell
 *              the data does not give.
 *   legacy     a table of measurements recorded before this check whose raw
 *              runs were not kept: dated, with why, until it is re-measured.
 *   reference  not a measurement (definitions, budgets, causes and where
 *              they live), with why.
 *
 * A new table that is none of these fails, so a measurement cannot land
 * without the manifest entry that makes it reproducible. Prose numbers outside
 * tables are out of scope.
 *
 * Usage: node scripts/check-perf-evidence.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MANIFEST = "docs/performance-data/manifest.json";
const SHA = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROVENANCE = ["fixture", "engine", "node", "viewport", "runs", "aggregation"];

const cellsOf = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/** Every pipe table in a Markdown file, with the heading it sits under. */
export function markdownTables(text) {
  const lines = text.split("\n");
  const tables = [];
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^#+\s+(.*)$/);
    if (heading) section = heading[1].trim();
    if (!line.startsWith("|") || !/^\|\s*:?-/.test(lines[index + 1] ?? "")) continue;
    const rows = [];
    let next = index + 2;
    for (; next < lines.length && lines[next].startsWith("|"); next += 1) rows.push(cellsOf(lines[next]));
    tables.push({ line: index + 1, section, header: cellsOf(line).join(" | "), rows });
    index = next - 1;
  }
  return tables;
}

const formatFixed = (value, digits) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function checkMeasured(root, entry, table, where) {
  const errors = [];
  const fail = (message) => errors.push(`${where}: ${message}`);
  for (const field of ["before", "after"]) if (!SHA.test(entry[field] ?? "")) fail(`"${field}" must be a full 40-character commit SHA`);
  if (!Array.isArray(entry.argv) || !entry.argv.length || entry.argv.some((arg) => typeof arg !== "string")) fail(`"argv" must list the exact command, one argument per item`);
  for (const field of PROVENANCE) if (typeof entry[field] !== "string" || !entry[field].trim()) fail(`"${field}" is missing`);
  if (typeof entry.metrics !== "object" || entry.metrics === null || !Object.keys(entry.metrics).length) fail(`"metrics" must define each figure the table shows`);
  for (const [field, file] of [["raw", entry.raw], ["figures", entry.figures]]) {
    if (typeof file !== "string" || !file) fail(`"${field}" is missing`);
    else if (!existsSync(path.join(root, file))) fail(`"${field}" names ${file}, which does not exist`);
  }
  if (errors.length) return errors;
  if (!entry.argv.includes(entry.raw)) fail(`"argv" does not write "raw" (${entry.raw}), so it is not the command that produced it`);

  const data = JSON.parse(readFileSync(path.join(root, entry.raw), "utf8"));
  const runs = data.results;
  if (!Array.isArray(runs) || !runs.length) return [...errors, `${where}: ${entry.raw} holds no runs under "results"`];
  if (data.options?.beforeRef && !entry.before.startsWith(data.options.beforeRef)) fail(`"before" is not the --before-ref the runs record (${data.options.beforeRef})`);
  const { readFigure } = await import(pathToFileURL(path.join(root, entry.figures)).href);

  const columns = table.header.split(" | ").length - 1;
  if (!Array.isArray(entry.columns) || entry.columns.length !== columns) return [...errors, `${where}: "columns" must select the runs of each of the table's ${columns} value columns`];
  if (!Array.isArray(entry.rows) || entry.rows.length !== table.rows.length) return [...errors, `${where}: "rows" must describe each of the table's ${table.rows.length} rows, in order`];
  entry.rows.forEach((row, index) => {
    const [label, ...cells] = table.rows[index];
    if (row.label !== label) fail(`row ${index + 1} is "${label}" in the document but "${row.label}" in the manifest`);
    const digits = row.digits ?? row.figures.map(() => 0);
    for (const name of row.figures) if (!entry.metrics[name]) fail(`"metrics" does not define "${name}"`);
    entry.columns.forEach((select, column) => {
      const chosen = runs.filter((run) => Object.entries(select).every(([key, value]) => run[key] === value));
      const expected = row.figures.map((name, figure) => {
        const values = chosen.map((run) => readFigure(run, name)).filter((value) => value !== null && value !== undefined);
        return values.length ? formatFixed(median(values), digits[figure]) : "–";
      }).join("; ");
      if (cells[column] !== expected) {
        fail(`"${label}", column ${column + 2}: the document says ${cells[column]}, the raw runs give ${expected}`);
      }
    });
  });
  return errors;
}

export async function checkPerfEvidence(root) {
  const manifestPath = path.join(root, MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const errors = [];
  const unclaimed = manifest.tables.map((entry, index) => ({ entry, index }));
  for (const doc of manifest.documents) {
    for (const table of markdownTables(readFileSync(path.join(root, doc), "utf8"))) {
      const where = `${doc}:${table.line} (${table.section} | ${table.header})`;
      const claim = unclaimed.findIndex(({ entry }) => entry.doc === doc && entry.section === table.section && entry.header === table.header);
      if (claim === -1) {
        errors.push(`${where}: not in ${MANIFEST}. A benchmark table needs a "measured" entry with its provenance and raw runs; a table that measures nothing is "reference".`);
        continue;
      }
      const [{ entry }] = unclaimed.splice(claim, 1);
      if (entry.kind === "measured") errors.push(...(await checkMeasured(root, entry, table, where)));
      else if (entry.kind === "legacy") {
        if (!DATE.test(entry.recorded ?? "")) errors.push(`${where}: a legacy table needs "recorded", the YYYY-MM-DD it landed`);
        if (!entry.why) errors.push(`${where}: a legacy table needs "why" its evidence is missing`);
      } else if (entry.kind === "reference") {
        if (!entry.why) errors.push(`${where}: a reference table needs "why" it measures nothing`);
      } else errors.push(`${where}: "kind" must be measured, legacy or reference`);
    }
  }
  for (const { entry } of unclaimed) errors.push(`${MANIFEST}: ${entry.doc} has no table "${entry.header}" under "${entry.section}"`);
  return errors;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = await checkPerfEvidence(root);
  for (const error of errors) console.error(error);
  if (errors.length) process.exit(1);
  console.log(`Performance evidence matches ${MANIFEST}.`);
}
