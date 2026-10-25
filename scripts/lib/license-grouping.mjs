/**
 * Collapses the license texts of many packages into one reproduction per
 * distinct license body, with every copyright notice that shares it.
 */

import { sha256 } from "./util.mjs";

// Only a line that *is* a copyright notice, not any line that mentions the
// word. Prose like "Not to remove any copyright notices from the Software"
// is part of the license body and has to stay there.
const COPYRIGHT_LINE = /^(portions\s+)?(copyright\b|\(c\)|©)/i;

/** Strip comment/markdown decoration so " * Copyright (c) X" still matches. */
function undecorate(line) {
  return line.replace(/^[\s*#>|/-]+/, "").trim();
}

const isCopyrightLine = (line) => COPYRIGHT_LINE.test(undecorate(line));

/**
 * Two hundred MIT licenses differ only in one copyright line. Grouping on the
 * license *body* with the copyright lines removed collapses them to a single
 * reproduction of the text plus the list of notices — which is what the license
 * actually requires and roughly a tenth of the bytes.
 */
function licenseBodyKey(text) {
  const stripped = text
    .split("\n")
    .filter((line) => !isCopyrightLine(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // A notice that is *only* a copyright line (a proprietary one-liner, say)
  // would otherwise group with every other one-liner.
  const basis = stripped.length > 40 ? stripped : text.replace(/\s+/g, " ").trim().toLowerCase();
  return sha256(basis).slice(0, 16);
}

export const compareIds = (a, b) => a.localeCompare(b, "en");
export const packageId = (entry) => `${entry.name}@${entry.version}`;

/** Count occurrences per key, most frequent first, ties by key. */
export function rankCounts(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
}

export function groupTexts(entries) {
  const groups = new Map();
  for (const entry of entries) {
    for (const text of entry.texts) {
      const key = licenseBodyKey(text.text);
      let group = groups.get(key);
      if (!group) {
        group = { key, text: text.text, fileName: text.name, packages: [], copyrights: new Set(), declared: [], declaredBy: new Map() };
        groups.set(key, group);
      }
      group.declared.push(entry.declared ?? "(no license field)");
      // Keep the longest variant as the representative: shorter ones are
      // usually the same license with a line of front matter missing. Ties break
      // lexicographically so the choice does not depend on traversal order.
      const longer = text.text.length - group.text.length;
      if (longer > 0 || (longer === 0 && text.text < group.text)) {
        group.text = text.text;
        group.fileName = text.name;
      }
      const id = packageId(entry);
      if (!group.packages.includes(id)) group.packages.push(id);
      group.declaredBy.set(id, entry.declared ?? "(no license field)");
      for (const line of text.text.split("\n").map(undecorate)) {
        if (line.length > 0 && COPYRIGHT_LINE.test(line)) group.copyrights.add(line);
      }
    }
  }
  return [...groups.values()]
    .map((group) => {
      const ranked = rankCounts(group.declared);
      const label =
        ranked.length === 1 ? ranked[0][0] : `${ranked[0][0]} (+${ranked.length - 1} other declarations)`;
      return { ...group, label, primary: ranked[0][0], packages: group.packages.sort(compareIds), copyrights: [...group.copyrights].sort() };
    })
    .sort((a, b) => b.packages.length - a.packages.length || a.key.localeCompare(b.key));
}
