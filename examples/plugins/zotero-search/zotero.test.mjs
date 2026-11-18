import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { toItems } from "./items.mjs";
import { search, splitBibtex } from "./zotero.mjs";

let server;
afterEach(() => server?.close());

/** A fake Zotero on a free port: `routes(method, path, body)` → [status, json]. */
async function zotero(routes) {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [status, json] = routes(req.method, req.url, body ? JSON.parse(body) : null);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}

const BIB = "@article{knuth1984,\n  title = {Literate Programming}\n}\n@book{lamport1994,\n  title = {LaTeX}\n}";

describe("zotero-search", () => {
  it("searches through Better BibTeX and exports its entries", async () => {
    const calls = [];
    const port = await zotero((method, path, body) => {
      calls.push(body?.method ?? path);
      if (body?.method === "api.ready") return [200, { result: { zotero: "7.0", betterbibtex: "7.0" } }];
      if (body?.method === "item.search")
        return [200, { result: [{ citekey: "knuth1984", title: "Literate Programming", author: [{ family: "Knuth", given: "D." }], issued: { "date-parts": [[1984]] }, DOI: "10.1093/comjnl/27.2.97", "container-title": "The Computer Journal" }] }];
      if (body?.method === "item.export") return [200, { result: BIB }];
      return [404, {}];
    });
    const [hit] = await search("knuth", port);
    expect(hit).toMatchObject({ key: "knuth1984", authors: "Knuth", year: "1984", source: "Better BibTeX" });
    expect(hit.bibtex).toContain("@article{knuth1984,");
    expect(calls).toEqual(["api.ready", "item.search", "item.export"]);
  });

  it("falls back to Zotero's local API without Better BibTeX", async () => {
    const port = await zotero((method, path) => {
      if (path.startsWith("/better-bibtex")) return [404, {}];
      expect(path).toContain("/api/users/0/items/top?q=lamport");
      return [200, [{ key: "ABCD1234", data: { title: "LaTeX", creators: [{ creatorType: "author", lastName: "Lamport" }], date: "1994-01-01" }, bibtex: "@book{lamport1994,\n title = {LaTeX}\n}" }]];
    });
    const [hit] = await search("lamport", port);
    expect(hit).toMatchObject({ key: "lamport1994", authors: "Lamport", year: "1994", source: "Zotero" });
  });

  it("explains how to turn the local API on when Zotero refuses", async () => {
    const port = await zotero((method, path) => (path.startsWith("/better-bibtex") ? [404, {}] : [403, {}]));
    await expect(search("x", port)).rejects.toThrow(/Allow other applications/);
  });

  it("says Zotero isn't running when nothing listens", async () => {
    const port = await zotero(() => [200, {}]);
    await new Promise((r) => server.close(r));
    server = undefined;
    await expect(search("x", port)).rejects.toThrow(/Zotero isn't running/);
  });

  it("cites what the project has, by key or by DOI, and adds the rest", () => {
    const hits = [
      { key: "knuth1984", title: "LP", authors: "Knuth", year: "1984", doi: "", url: "", bibtex: "@article{knuth1984,}" },
      { key: "other2020", title: "Same DOI", authors: "", year: "", doi: "https://doi.org/10.1/X", url: "", bibtex: "@misc{other2020,}" },
      { key: "new2021", title: "New", authors: "", year: "2021", doi: "", url: "https://example.org/p", bibtex: "@misc{new2021,}" },
    ];
    const items = toItems(hits, { keys: new Set(["knuth1984"]), byDoi: new Map([["10.1/x", "dup2020"]]) });
    expect(items[0].actions[0]).toEqual({ type: "insertCitation", key: "knuth1984", title: "Cite" });
    expect(items[0].badges).toEqual(["In bibliography"]);
    expect(items[1].actions[0]).toEqual({ type: "insertCitation", key: "dup2020", title: "Cite" });
    expect(items[1].actions.at(-1)).toEqual({ type: "openUrl", url: "https://doi.org/10.1/x", title: "Open" });
    expect(items[2].actions.map((a) => a.type)).toEqual(["addBibEntry", "copy", "openUrl"]);
    expect(items[2].subtitle).toBe("2021");
  });

  it("splits a multi-entry export by key", () => {
    expect([...splitBibtex(BIB).keys()]).toEqual(["knuth1984", "lamport1994"]);
  });
});
