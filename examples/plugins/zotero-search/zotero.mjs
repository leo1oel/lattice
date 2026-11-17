// SPDX-License-Identifier: MIT
// Talking to the Zotero running on this Mac, on 127.0.0.1:23119 (the only
// port this plugin's manifest opens). Better BibTeX first, for its stable
// citation keys and exports; Zotero 7's local API otherwise.
import http from "node:http";

export const ZOTERO_PORT = 23119;
const LIMIT = 20;

export class ZoteroUnavailable extends Error {}

function request(port, { method = "GET", path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, timeout: 10_000, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zotero did not answer in 10 seconds.")));
    req.on("error", (error) =>
      reject(error.code === "ECONNREFUSED" ? new ZoteroUnavailable("Zotero isn't running. Open Zotero and try again.") : error),
    );
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function betterBibtex(port, method, params) {
  const res = await request(port, {
    method: "POST",
    path: "/better-bibtex/json-rpc",
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
  if (res.status !== 200) return null;
  const reply = JSON.parse(res.text);
  if (reply.error) throw new Error(`Better BibTeX: ${reply.error.message}`);
  return reply.result;
}

const authors = (names = []) => {
  const family = names.map((n) => n.family ?? n.lastName ?? n.literal ?? n.name).filter(Boolean);
  return family.length > 2 ? `${family[0]} et al.` : family.join(" and ");
};

/** Split an export of several entries into BibTeX per key. */
export function splitBibtex(text) {
  const entries = new Map();
  for (const chunk of text.split(/\n(?=@)/)) {
    const match = /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(chunk);
    if (match) entries.set(match[1], chunk.trim());
  }
  return entries;
}

/** Search; each hit is { key, title, authors, year, venue, doi, url, bibtex }. */
export async function search(query, port = ZOTERO_PORT) {
  let ready = null;
  try {
    ready = await betterBibtex(port, "api.ready", []);
  } catch (error) {
    if (error instanceof ZoteroUnavailable) throw error;
  }
  return ready ? searchBetterBibtex(query, port) : searchLocalApi(query, port);
}

async function searchBetterBibtex(query, port) {
  const found = ((await betterBibtex(port, "item.search", [query])) ?? []).slice(0, LIMIT);
  const keys = found.map((item) => item.citekey ?? item["citation-key"]).filter(Boolean);
  let exported = keys.length ? await betterBibtex(port, "item.export", [keys, "Better BibTeX"]) : "";
  // Older Better BibTeX answers [status, contentType, text].
  if (Array.isArray(exported)) exported = exported[2] ?? "";
  const bibtex = splitBibtex(exported ?? "");
  return found.map((item) => {
    const key = item.citekey ?? item["citation-key"];
    return {
      key,
      title: item.title ?? key,
      authors: authors(item.author),
      year: item.issued?.["date-parts"]?.[0]?.[0]?.toString() ?? "",
      venue: item["container-title"] ?? "",
      doi: item.DOI ?? "",
      url: item.URL ?? "",
      bibtex: bibtex.get(key) ?? "",
      source: "Better BibTeX",
    };
  });
}

async function searchLocalApi(query, port) {
  const params = new URLSearchParams({ q: query, qmode: "titleCreatorYear", limit: String(LIMIT), include: "data,bibtex" });
  const res = await request(port, { path: `/api/users/0/items/top?${params}` });
  if (res.status === 403 || res.status === 404) {
    throw new ZoteroUnavailable(
      'Zotero\'s local API is off. In Zotero, open Settings › Advanced and turn on "Allow other applications on this computer to communicate with Zotero", or install Better BibTeX.',
    );
  }
  if (res.status !== 200) throw new Error(`Zotero answered HTTP ${res.status}.`);
  return JSON.parse(res.text).map((item) => {
    const data = item.data ?? {};
    const bibtex = (item.bibtex ?? "").trim();
    const key = /^\s*@\w+\s*\{\s*([^,\s]+)/.exec(bibtex)?.[1] ?? item.key;
    return {
      key,
      title: data.title || key,
      authors: authors((data.creators ?? []).filter((c) => c.creatorType === "author" || !c.creatorType)),
      year: /\d{4}/.exec(data.date ?? "")?.[0] ?? "",
      venue: data.publicationTitle ?? data.proceedingsTitle ?? data.bookTitle ?? "",
      doi: data.DOI ?? "",
      url: data.url ?? "",
      bibtex,
      source: "Zotero",
    };
  });
}
