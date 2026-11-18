// SPDX-License-Identifier: MIT
// Zotero hits as palette items, given the keys the project already has.
import { HostError } from "./lattice-plugin.mjs";

export const normalizeDoi = (doi) => doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase();

/** The project's keys, and its keys by DOI, so a hit already cited under
 *  another key is cited by that key. */
export async function projectKeys(host) {
  try {
    const { files } = await host.bibliographyEntries();
    const keys = new Set();
    const byDoi = new Map();
    for (const entry of files.flatMap((f) => f.entries)) {
      keys.add(entry.key);
      if (entry.fields.doi) byDoi.set(normalizeDoi(entry.fields.doi), entry.key);
    }
    return { keys, byDoi };
  } catch (error) {
    if (error instanceof HostError) return { keys: new Set(), byDoi: new Map() };
    throw error;
  }
}

export function toItems(hits, { keys, byDoi }) {
  return hits.map((hit) => {
    const existing = keys.has(hit.key) ? hit.key : hit.doi ? byDoi.get(normalizeDoi(hit.doi)) : undefined;
    const actions = existing
      ? [{ type: "insertCitation", key: existing, title: "Cite" }]
      : hit.bibtex
        ? [{ type: "addBibEntry", bibtex: hit.bibtex, title: "Add to bibliography" }]
        : [];
    if (hit.bibtex) actions.push({ type: "copy", text: hit.bibtex, title: "Copy BibTeX" });
    const link = hit.doi ? `https://doi.org/${normalizeDoi(hit.doi)}` : /^https?:\/\//.test(hit.url) ? hit.url : "";
    if (link) actions.push({ type: "openUrl", url: link, title: "Open" });
    return {
      id: hit.key,
      title: hit.title,
      subtitle: [hit.authors, hit.year].filter(Boolean).join(" · ") || undefined,
      detail: [hit.venue, existing ? `\\cite{${existing}}` : hit.key].filter(Boolean).join(" · "),
      badges: existing ? ["In bibliography"] : [],
      actions,
    };
  });
}
