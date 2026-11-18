// SPDX-License-Identifier: MIT
// The checks, as a pure function of bibliography/entries' result.

/** Required fields per entry type (BibTeX's standard styles); `a|b` is either. */
const REQUIRED = {
  article: ["author", "title", "journal", "year"],
  book: ["author|editor", "title", "publisher", "year"],
  inproceedings: ["author", "title", "booktitle", "year"],
  conference: ["author", "title", "booktitle", "year"],
  incollection: ["author", "title", "booktitle", "publisher", "year"],
  inbook: ["author|editor", "title", "chapter|pages", "publisher", "year"],
  phdthesis: ["author", "title", "school", "year"],
  mastersthesis: ["author", "title", "school", "year"],
  techreport: ["author", "title", "institution", "year"],
  manual: ["title"],
  unpublished: ["author", "title", "note"],
};

const DOI_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i;

export function normalizeDoi(doi) {
  return doi.trim().replace(DOI_PREFIX, "").toLowerCase();
}

/** One entry back as BibTeX, from the fields bibliography/entries gives. */
export function toBibtex(entry, fields = entry.fields) {
  const body = Object.entries(fields)
    .map(([name, value]) => `  ${name} = {${value}}`)
    .join(",\n");
  return `@${entry.type}{${entry.key},\n${body}\n}`;
}

export function check(files) {
  const diagnostics = [];
  const add = (file, entry, severity, code, message, fixes = []) =>
    diagnostics.push({
      id: `${code}:${file}:${entry.line}`,
      file,
      line: entry.line,
      severity,
      code,
      message,
      fixes: [{ type: "reveal", file, line: entry.line, title: "Show" }, ...fixes],
    });

  const byKey = new Map();
  const byDoi = new Map();
  for (const file of files) {
    if (file.error) {
      diagnostics.push({ id: `parse:${file.path}`, file: file.path, severity: "error", code: "parse-error", message: file.error, fixes: [] });
      continue;
    }
    for (const entry of file.entries) {
      const where = { file: file.path, entry };
      const lowerKey = entry.key.toLowerCase();
      if (byKey.has(lowerKey)) {
        const first = byKey.get(lowerKey);
        add(file.path, entry, "error", "duplicate-key", `“${entry.key}” is already defined in ${first.file} (line ${first.entry.line}).`);
      } else {
        byKey.set(lowerKey, where);
      }

      const doi = entry.fields.doi;
      if (doi) {
        const normalized = normalizeDoi(doi);
        if (byDoi.has(normalized)) {
          const first = byDoi.get(normalized);
          add(file.path, entry, "warning", "duplicate-doi", `Same DOI as “${first.entry.key}” (${first.file}, line ${first.entry.line}).`);
        } else {
          byDoi.set(normalized, where);
        }
        if (normalized !== doi.trim()) {
          const fields = { ...entry.fields, doi: normalized };
          add(file.path, entry, "info", "doi-format", `Write the DOI of “${entry.key}” as ${normalized}.`, [
            { type: "replaceBibEntry", key: entry.key, file: file.path, bibtex: toBibtex(entry, fields), title: "Normalize DOI" },
          ]);
        }
      }

      for (const field of REQUIRED[entry.type] ?? []) {
        const options = field.split("|");
        if (!options.some((name) => entry.fields[name]?.trim())) {
          add(file.path, entry, "warning", "missing-field", `“${entry.key}” (@${entry.type}) has no ${options.join(" or ")}.`);
        }
      }

      const year = entry.fields.year?.trim();
      if (year && !/^\d{4}$/.test(year)) {
        add(file.path, entry, "warning", "bad-year", `The year of “${entry.key}” is “${year}”, not a four-digit year.`);
      }
    }
  }
  return diagnostics;
}
