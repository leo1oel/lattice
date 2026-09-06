import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Interception = { origin: string; method: string; path: string | RegExp; status: number; body: string; headers?: Record<string, string> };
const interceptions: Interception[] = [];
const fetchMock = {
  disableNetConnect() {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const index = interceptions.findIndex((item) => item.origin === url.origin && item.method === method && (typeof item.path === "string" ? item.path === `${url.pathname}${url.search}` : item.path.test(`${url.pathname}${url.search}`)));
      if (index < 0) throw new Error(`network disabled: ${method} ${url.origin}${url.pathname}`);
      const item = interceptions.splice(index, 1)[0];
      return new Response(item.body, { status: item.status, headers: item.headers });
    }));
  },
  get(origin: string) {
    return { intercept({ method = "GET", path }: { method?: string; path: string | RegExp }) {
      return { reply(status: number, body = "", options?: { headers?: Record<string, string> }) {
        interceptions.push({ origin, method, path, status, body, headers: options?.headers });
      } };
    } };
  },
  assertNoPendingInterceptors() { expect(interceptions).toEqual([]); },
};

function query(provider: string, path: string, params: Record<string, string> = {}, body?: object) {
  return SELF.fetch("https://worker/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
    body: JSON.stringify({ provider, path, params, ...(body ? { body } : {}) }),
  });
}

describe("literature proxy", () => {
  beforeAll(() => fetchMock.disableNetConnect());

  it("rejects SSRF-shaped paths and unknown parameters", async () => {
    expect((await query("openalex", "https://evil.example/works")).status).toBe(400);
    expect((await query("openalex", "/works/../authors", { token: "secret" })).status).toBe(400);
    expect((await query("semanticscholar", "/graph/v1/paper/abc/citations")).status).toBe(400);
    expect((await query("crossref", "/works", { mailto: "attacker@example.com" })).status).toBe(400);
    expect((await query("crossref", "/works", { rows: "101" })).status).toBe(400);
  });

  it("enforces the streamed request size limit", async () => {
    const response = await SELF.fetch("https://worker/v1/query", {
      method: "POST",
      headers: { "CF-Connecting-IP": crypto.randomUUID() },
      body: JSON.stringify({ provider: "openalex", path: "/works", params: { search: "x".repeat(17_000) } }),
    });
    expect(response.status).toBe(413);
  });

  it("does not reflect rejected values in errors", async () => {
    const secret = "attacker-supplied-secret";
    const failed = await query("semanticscholar", `/graph/v1/paper/id/${secret}`);
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain(secret);
  });

  it("rejects oversized and malformed S2 batches", async () => {
    expect((await query("semanticscholar", "/graph/v1/paper/batch", {}, { ids: [] })).status).toBe(400);
    expect((await query("semanticscholar", "/graph/v1/paper/batch", {}, { ids: Array.from({ length: 21 }, (_, index) => String(index)) })).status).toBe(400);
  });

  it("health only exposes configuration booleans", async () => {
    const response = await SELF.fetch("https://worker/health");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("api_key");
    expect(JSON.parse(text)).toMatchObject({ ok: true, configured: { openalex: true, semanticscholar: true, crossref: true } });
  });

  it("reuses normalized cache entries for duplicate requests", async () => {
    const upstream = fetchMock.get("https://api.openalex.org");
    upstream.intercept({ method: "GET", path: /\/works\?.*/ }).reply(200, JSON.stringify({ id: "cached" }), { headers: { "content-type": "application/json" } });

    const first = await query("openalex", "/works", { search: "cache", page: "1" });
    const duplicate = await query("openalex", "/works", { page: "1", search: "cache" });
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await first.json()).toEqual({ id: "cached" });
    expect(await duplicate.json()).toEqual({ id: "cached" });
    expect((await query("openalex", "/works", { page: "1", search: "cache" })).status).toBe(200);
    fetchMock.assertNoPendingInterceptors();
  });

  it("supports S2 batches and enforces durable pacing and daily quota across endpoints", async () => {
    const upstream = fetchMock.get("https://api.semanticscholar.org");
    upstream.intercept({ method: "POST", path: /\/graph\/v1\/paper\/batch.*/ }).reply(200, "[{\"paperId\":\"a\"}]");
    expect((await query("semanticscholar", "/graph/v1/paper/batch", { fields: "title" }, { ids: ["CorpusId:1"] })).status).toBe(200);

    upstream.intercept({ method: "GET", path: /\/graph\/v1\/paper\/CorpusId:2.*/ }).reply(200, "{\"paperId\":\"b\"}");
    expect((await query("semanticscholar", "/graph/v1/paper/CorpusId:2", { fields: "title" })).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect((await query("semanticscholar", "/graph/v1/paper/CorpusId:2", { fields: "title" })).status).toBe(200);

    upstream.intercept({ method: "GET", path: /\/graph\/v1\/paper\/ARXIV:2401\.00001.*/ }).reply(200, "{\"paperId\":\"c\"}");
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect((await query("semanticscholar", "/graph/v1/paper/ARXIV:2401.00001", { fields: "title" })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect((await query("semanticscholar", "/graph/v1/paper/DOI:10.1000/test", { fields: "title" })).status).toBe(429);
    fetchMock.assertNoPendingInterceptors();
  });

  it("refreshes expired metadata instead of keeping cached records indefinitely", async () => {
    const upstream = fetchMock.get("https://api.openalex.org");
    upstream.intercept({ path: /\/works\/W101.*/ }).reply(200, "{\"title\":\"before\"}");
    expect(await (await query("openalex", "/works/W101")).json()).toEqual({ title: "before" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3600_001);
    try {
      upstream.intercept({ path: /\/works\/W101.*/ }).reply(200, "{\"title\":\"after\"}");
      expect(await (await query("openalex", "/works/W101")).json()).toEqual({ title: "after" });
    } finally {
      clock.mockRestore();
    }
    fetchMock.assertNoPendingInterceptors();
  });

  it("maps upstream failures safely, preserves 404, and rejects oversized or secret-echoing bodies", async () => {
    const upstream = fetchMock.get("https://api.crossref.org");
    upstream.intercept({ path: /\/works\/10\.1000\/missing.*/ }).reply(404, "upstream details");
    const missing = await query("crossref", "/works/10.1000/missing");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("upstream details");

    upstream.intercept({ path: /\/works\/10\.1000\/unauthorized.*/ }).reply(401, "credential rejected");
    expect((await query("crossref", "/works/10.1000/unauthorized")).status).toBe(503);
    upstream.intercept({ path: /\/works\/10\.1000\/broken.*/ }).reply(500, "internal secret detail");
    const broken = await query("crossref", "/works/10.1000/broken");
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toContain("internal secret detail");

    const oa = fetchMock.get("https://api.openalex.org");
    oa.intercept({ path: /\/works\/W99.*/ }).reply(200, "oa-test-secret");
    const echo = await query("openalex", "/works/W99");
    expect(echo.status).toBe(502);
    expect(await echo.text()).not.toContain("oa-test-secret");
    oa.intercept({ path: /\/works\/W100.*/ }).reply(200, "x".repeat(1024 * 1024 + 1));
    expect((await query("openalex", "/works/W100")).status).toBe(502);
    fetchMock.assertNoPendingInterceptors();
  });
});
