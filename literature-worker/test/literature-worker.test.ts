import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const OPENALEX = "https://api.openalex.org";
const CROSSREF = "https://api.crossref.org";
/** Canned upstream replies, each consumed by the first matching GET; any other request fails as a network error. */
const replies: Array<{ origin: string; path: RegExp; status: number; body: string; headers?: Record<string, string> }> = [];
const openAlexKeys: string[] = [];
const reply = (origin: string, path: RegExp, status: number, body = "", headers?: Record<string, string>) => { replies.push({ origin, path, status, body, headers }); };

function stubUpstream() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const index = replies.findIndex((item) => method === "GET" && item.origin === url.origin && item.path.test(`${url.pathname}${url.search}`));
    if (index < 0) throw new Error(`network disabled: ${method} ${url.origin}${url.pathname}`);
    const [item] = replies.splice(index, 1);
    if (url.origin === OPENALEX) openAlexKeys.push(url.searchParams.get("api_key") ?? "");
    return new Response(item.body, { status: item.status, headers: item.headers });
  }));
}

function query(provider: string, path: string, params: Record<string, string> = {}, body?: object) {
  const init = { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": crypto.randomUUID() } };
  return SELF.fetch("https://worker/v1/query", { ...init, body: JSON.stringify({ provider, path, params, ...(body ? { body } : {}) }) });
}
const lastUpstreamUrl = () => new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]));

describe("literature proxy", () => {
  beforeAll(stubUpstream);
  beforeEach(async () => {
    replies.length = 0;
    openAlexKeys.length = 0;
    const namespace = (env as unknown as { LiteratureBudget: DurableObjectNamespace }).LiteratureBudget;
    await runInDurableObject(namespace.getByName("global-v1"), async (_instance, state) => state.storage.deleteAll());
  });
  afterEach(() => expect(replies).toEqual([]));

  it("rejects SSRF-shaped paths and unknown parameters", async () => {
    expect((await query("openalex", "https://evil.example/works")).status).toBe(400);
    expect((await query("openalex", "/works/../authors", { token: "secret" })).status).toBe(400);
    expect((await query("semanticscholar", "/graph/v1/paper/abc/citations")).status).toBe(400);
    expect((await query("crossref", "/works", { mailto: "attacker@example.com" })).status).toBe(400);
    expect((await query("crossref", "/works", { rows: "101" })).status).toBe(400);
  });

  it("enforces the streamed request size limit", async () => {
    const body = JSON.stringify({ provider: "openalex", path: "/works", params: { search: "x".repeat(17_000) } });
    expect((await SELF.fetch("https://worker/v1/query", { method: "POST", headers: { "CF-Connecting-IP": crypto.randomUUID() }, body })).status).toBe(413);
  });

  it("does not reflect rejected values in errors", async () => {
    const secret = "attacker-supplied-secret";
    const failed = await query("openalex", `/works/${secret}`);
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain(secret);
  });

  it("rejects request bodies, which no proxied query takes", async () => {
    expect((await query("openalex", "/works", {}, { ids: ["W1"] })).status).toBe(400);
  });

  it("health only exposes configuration booleans", async () => {
    const response = await SELF.fetch("https://worker/health");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("api_key");
    expect(JSON.parse(text)).toMatchObject({ ok: true, configured: { openalex: true, crossref: true } });
  });

  it("reuses normalized cache entries for duplicate requests", async () => {
    reply(OPENALEX, /\/works\?.*/, 200, JSON.stringify({ id: "cached" }), { "content-type": "application/json" });
    const first = await query("openalex", "/works", { search: "cache", page: "1" });
    const duplicate = await query("openalex", "/works", { page: "1", search: "cache" });
    expect([first.status, duplicate.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ id: "cached" });
    expect(await duplicate.json()).toEqual({ id: "cached" });
    expect((await query("openalex", "/works", { page: "1", search: "cache" })).status).toBe(200);
  });

  it("searches literal paper titles without sending OpenAlex wildcard syntax", async () => {
    const title = "Why Solve It Twice? Hierarchical Accumulation of Skills for Transfer-Efficient ML Engineering";
    reply(OPENALEX, /\/works\?.*/, 200, JSON.stringify({ results: [{ title }] }));
    const response = await query("openalex", "/works", { search: title, "per-page": "5" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ title }] });
    expect(lastUpstreamUrl().searchParams.get("search")).toBe("Why Solve It Twice Hierarchical Accumulation of Skills for Transfer-Efficient ML Engineering");
    expect(lastUpstreamUrl().searchParams.get("per-page")).toBe("5");
    reply(OPENALEX, /\/works\?.*/, 200, "{}");
    expect((await query("openalex", "/works", { search: "A* search?" })).status).toBe(200);
    expect(lastUpstreamUrl().searchParams.get("search")).toBe("A search");
    expect((await query("openalex", "/works", { search: "? *" })).status).toBe(400);
  });

  it("does not report a rejected upstream query as a server outage", async () => {
    reply(OPENALEX, /\/works\?.*/, 400, "upstream details with api_key=secret");
    const response = await query("openalex", "/works", { search: "invalid query" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "provider rejected query", code: "upstream_bad_request" });
  });

  it("selects OpenAlex keys from the pool without exposing them", async () => {
    reply(OPENALEX, /\/works\/W201.*/, 200, "{}");
    reply(OPENALEX, /\/works\/W202.*/, 200, "{}");
    const [first, second] = await Promise.all([query("openalex", "/works/W201"), query("openalex", "/works/W202")]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(new Set(openAlexKeys)).toEqual(new Set(["oa-test-secret-a", "oa-test-secret-b"]));
    expect(await (await SELF.fetch("https://worker/health")).text()).not.toContain("test-secret");
  });

  it("rejects Semantic Scholar as an unknown provider even with stale secret bindings", async () => {
    const response = await query("semanticscholar", "/graph/v1/paper/CorpusId:2", { fields: "title" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid provider" });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("semanticscholar.org"), expect.anything());
  });

  it("refreshes expired metadata instead of keeping cached records indefinitely", async () => {
    reply(OPENALEX, /\/works\/W101.*/, 200, "{\"title\":\"before\"}");
    expect(await (await query("openalex", "/works/W101")).json()).toEqual({ title: "before" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600_001);
    try {
      reply(OPENALEX, /\/works\/W101.*/, 200, "{\"title\":\"after\"}");
      expect(await (await query("openalex", "/works/W101")).json()).toEqual({ title: "after" });
    } finally {
      clock.mockRestore();
    }
  });

  it("maps upstream failures safely, preserves 404, and rejects oversized or secret-echoing bodies", async () => {
    reply(CROSSREF, /\/works\/10\.1000\/missing.*/, 404, "upstream details");
    const missing = await query("crossref", "/works/10.1000/missing");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("upstream details");
    reply(CROSSREF, /\/works\/10\.1000\/unauthorized.*/, 401, "credential rejected");
    const unauthorized = await query("crossref", "/works/10.1000/unauthorized");
    expect(unauthorized.status).toBe(503);
    expect(await unauthorized.json()).toMatchObject({ code: "provider_unauthorized" });
    reply(CROSSREF, /\/works\/10\.1000\/broken.*/, 500, "internal secret detail");
    const broken = await query("crossref", "/works/10.1000/broken");
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toContain("internal secret detail");

    reply(OPENALEX, /\/works\/W99.*/, 200, "oa-test-secret-a oa-test-secret-b");
    const echo = await query("openalex", "/works/W99");
    expect(echo.status).toBe(502);
    const echoBody = await echo.text();
    expect(echoBody).not.toContain("oa-test-secret");
    expect(JSON.parse(echoBody)).toMatchObject({ code: "upstream_malformed" });
    reply(OPENALEX, /\/works\/W100.*/, 200, "x".repeat(1024 * 1024 + 1));
    expect((await query("openalex", "/works/W100")).status).toBe(502);
  });
});
