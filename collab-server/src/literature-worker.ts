import { DurableObject } from "cloudflare:workers";

export interface Env {
  LiteratureBudget: DurableObjectNamespace<LiteratureBudget>;
  LiteratureRateLimiter: RateLimit;
  OPENALEX_API_KEYS?: string;
  CROSSREF_EMAIL?: string;
  OPENALEX_DAILY_QUOTA?: string;
  CROSSREF_DAILY_QUOTA?: string;
}

type Provider = "openalex" | "semanticscholar" | "crossref";
type Query = {
  provider: Provider;
  path: string;
  params: Record<string, string>;
  body?: { ids: string[] };
};

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_CACHE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const PROJECT_URL = "https://github.com/leo1oel/bibcite";
const HOSTS: Record<Provider, string> = {
  openalex: "api.openalex.org",
  // Kept in the request type for old-client compatibility, but never dispatched.
  semanticscholar: "disabled.invalid",
  crossref: "api.crossref.org",
};
const PARAMS: Record<Provider, Set<string>> = {
  openalex: new Set(["search", "filter", "per-page", "per_page", "page", "select"]),
  semanticscholar: new Set(["fields", "query", "limit", "year"]),
  crossref: new Set(["query.title", "query.bibliographic", "rows", "select", "filter"]),
};

class ClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function jsonError(status: number, error: string, code?: string): Response {
  return Response.json({ error, ...(code ? { code } : {}) }, { status });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ClientError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new ClientError(413, "request too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ClientError(400, "invalid JSON");
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ClientError(400, "invalid path");
  }
}

function validDoi(value: string): boolean {
  const decoded = safeDecode(value);
  return /^10\.\d{4,9}\/[^\s?#]+$/i.test(decoded) && !decoded.includes("..") && !decoded.includes("\\");
}

function validatePath(provider: Provider, path: string): void {
  if (!path.startsWith("/")) throw new ClientError(400, "invalid path");
  const decodedPath = safeDecode(path);
  if (decodedPath.includes("?") || decodedPath.includes("#") || /[%\0-\x1f\\]/.test(decodedPath) || decodedPath.includes("..")) {
    throw new ClientError(400, "invalid path");
  }
  path = decodedPath;
  if (provider === "openalex") {
    if (path === "/works") return;
    const id = path.slice("/works/".length);
    if (path.startsWith("/works/") && (/^W\d+$/.test(id) || (id.startsWith("https://doi.org/") && validDoi(id.slice(16))))) return;
  } else if (provider === "semanticscholar") {
    if (path === "/graph/v1/paper/search" || path === "/graph/v1/paper/batch") return;
    const id = path.slice("/graph/v1/paper/".length);
    const arxiv = /^(?:ARXIV|arXiv):(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/;
    if (path.startsWith("/graph/v1/paper/") && (/^[a-fA-F0-9]{40}$/.test(id) || /^CorpusId:\d+$/.test(id) || arxiv.test(id) || /^DOI:10\.\d{4,9}\/[^\s/?#]+(?:\/[^\s?#]+)*$/.test(id))) return;
  } else {
    if (path === "/works") return;
    const prefix = "/works/";
    if (path.startsWith(prefix)) {
      const tail = path.slice(prefix.length);
      const suffix = "/transform/application/x-bibtex";
      const doi = tail.endsWith(suffix) ? tail.slice(0, -suffix.length) : tail;
      if (validDoi(doi)) return;
    }
  }
  throw new ClientError(400, "path is not allowed");
}

export function validateQuery(input: unknown): Query {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ClientError(400, "invalid request");
  const value = input as Record<string, unknown>;
  if (!(["openalex", "semanticscholar", "crossref"] as unknown[]).includes(value.provider)) {
    throw new ClientError(400, "invalid provider");
  }
  const provider = value.provider as Provider;
  if (typeof value.path !== "string" || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) {
    throw new ClientError(400, "invalid request");
  }
  validatePath(provider, value.path);
  const params: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value.params as Record<string, unknown>)) {
    if (!PARAMS[provider].has(key) || typeof raw !== "string" || raw.length > 2048) {
      throw new ClientError(400, "query parameter is not allowed");
    }
    params[key] = raw;
  }
  const limitKeys = provider === "openalex" ? ["per-page", "per_page"] : provider === "crossref" ? ["rows"] : ["limit"];
  for (const limitKey of limitKeys) {
    if (params[limitKey] === undefined) continue;
    const limit = Number(params[limitKey]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ClientError(400, "limit must be between 1 and 100");
  }
  let body: Query["body"];
  if (value.body !== undefined) {
    if (provider !== "semanticscholar" || value.path !== "/graph/v1/paper/batch" || !value.body || typeof value.body !== "object") {
      throw new ClientError(400, "body is not allowed");
    }
    const ids = (value.body as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => typeof id !== "string" || !id || id.length > 512)) {
      throw new ClientError(400, "batch requires 1 to 20 ids");
    }
    body = { ids: ids as string[] };
  } else if (provider === "semanticscholar" && value.path === "/graph/v1/paper/batch") {
    throw new ClientError(400, "batch body required");
  }
  if (value.purpose !== undefined && (value.purpose !== "audit" || !body)) throw new ClientError(400, "invalid purpose");
  return { provider, path: value.path, params: Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))), ...(body ? { body } : {}) };
}

function health(env: Env): Response {
  return Response.json({ ok: true, configured: {
    openalex: parseKeyPool(env.OPENALEX_API_KEYS).length > 0,
    semanticscholar: false,
    crossref: !!env.CROSSREF_EMAIL,
  } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return health(env);
    if (request.method !== "POST" || url.pathname !== "/v1/query") return jsonError(404, "not found");
    try {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await env.LiteratureRateLimiter.limit({ key: ip })).success) return jsonError(429, "rate limit exceeded");
      const query = validateQuery(await readBoundedJson(request));
      // Semantic Scholar only permits personal client credentials. Reject old
      // public-fallback clients before they can reach the Durable Object.
      if (query.provider === "semanticscholar") return jsonError(503, "literature provider is disabled", "provider_disabled");
      const id = env.LiteratureBudget.idFromName("global-v1");
      return await env.LiteratureBudget.get(id).fetch("https://literature.internal/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      });
    } catch (error) {
      if (error instanceof ClientError) return jsonError(error.status, error.message);
      return jsonError(502, "literature service unavailable");
    }
  },
} satisfies ExportedHandler<Env>;

type BudgetState = { day: string; count: number };
type KeyState = { lastReserved?: number; cooldownUntil?: number };
type PoolKey = { secret: string; id: string };
type Reservation = { ok: true; key: PoolKey } | { ok: false; reason: "quota" | "cooldown" };

const DEFAULT_COOLDOWN_MS = 5000;
const MAX_COOLDOWN_MS = 60_000;

type SharedResponse = { bytes: ArrayBuffer; status: number; headers: Headers };

function parseKeyPool(raw?: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((key): key is string => typeof key === "string" && key.length > 0))]
      : [];
  } catch {
    return [];
  }
}

export class LiteratureBudget extends DurableObject<Env> {
  private readonly inFlight = new Map<string, Promise<SharedResponse>>();
  private readonly cache = new Map<string, { bytes: ArrayBuffer; contentType: string; expiresAt: number }>();
  private cacheBytes = 0;
  private readonly bindings: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const query = validateQuery(await request.json());
      const key = await this.cacheKey(query);
      const cached = this.cache.get(key);
      if (cached) {
        this.cache.delete(key);
        if (cached.expiresAt > Date.now()) {
          this.cache.set(key, cached);
          return new Response(cached.bytes.slice(0), { headers: { "content-type": cached.contentType, "cache-control": "no-store" } });
        }
        this.cacheBytes -= cached.bytes.byteLength;
      }
      const existing = this.inFlight.get(key);
      if (existing) return await this.responseFor(existing);
      if (this.inFlight.size >= 40) return jsonError(429, "literature service busy", "queue_busy");
      // Share immutable data, not a Response stream owned by another request.
      // Each consumer gets its own body, with no tee/backpressure coupling.
      const operation = this.dispatch(query, key).then(async (response) => ({
        bytes: await response.arrayBuffer(), status: response.status, headers: response.headers,
      }));
      this.inFlight.set(key, operation);
      try {
        return await this.responseFor(operation);
      } finally {
        this.inFlight.delete(key);
      }
    } catch (error) {
      if (error instanceof ClientError) return jsonError(error.status, error.message);
      console.warn("literature dispatch failed", error instanceof Error ? error.name : "unknown");
      return jsonError(502, "upstream request failed");
    }
  }

  private async responseFor(operation: Promise<SharedResponse>): Promise<Response> {
    const { bytes, status, headers } = await operation;
    return new Response(bytes.slice(0), { status, headers });
  }

  private async cacheKey(query: Query): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify({ provider: query.provider, path: query.path, params: query.params, ...(query.body ? { body: query.body } : {}) }));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private quota(provider: Provider): number {
    const raw = provider === "openalex" ? this.bindings.OPENALEX_DAILY_QUOTA : this.bindings.CROSSREF_DAILY_QUOTA;
    const parsed = Number(raw ?? "5000");
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 5000;
  }

  private async poolKeys(provider: Provider): Promise<PoolKey[]> {
    const secrets = provider === "openalex"
      ? parseKeyPool(this.bindings.OPENALEX_API_KEYS)
      : provider === "crossref" ? [""] : [];
    return Promise.all(secrets.map(async (secret) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}\0${secret}`));
      return { secret, id: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    }));
  }

  private async reserve(provider: Provider, keys: PoolKey[]): Promise<Reservation> {
    return this.ctx.storage.transaction(async (tx) => {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const budgetKey = `budget:${provider}`;
      const current = (await tx.get<BudgetState>(budgetKey)) ?? { day, count: 0 };
      const budget = current.day === day ? current : { day, count: 0 };
      if (budget.count >= this.quota(provider)) return { ok: false, reason: "quota" };
      const states = await Promise.all(keys.map(async (key) => ({ key, state: (await tx.get<KeyState>(`key:${provider}:${key.id}`)) ?? {} })));
      const healthy = states.filter(({ state }) => (state.cooldownUntil ?? 0) <= now);
      if (healthy.length === 0) return { ok: false, reason: "cooldown" };
      const selected = healthy.reduce((best, item) => (item.state.lastReserved ?? 0) < (best.state.lastReserved ?? 0) ? item : best);
      await tx.put(budgetKey, { day, count: budget.count + 1 });
      await tx.put(`key:${provider}:${selected.key.id}`, {
        ...selected.state,
        lastReserved: now,
      });
      return { ok: true, key: selected.key };
    });
  }

  private async establishCooldown(provider: Provider, key: PoolKey, response: Response): Promise<number> {
    const now = Date.now();
    const raw = response.headers.get("retry-after");
    let duration = DEFAULT_COOLDOWN_MS;
    if (raw) {
      const seconds = Number(raw);
      const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
      if (Number.isFinite(parsed)) duration = Math.max(1000, Math.min(MAX_COOLDOWN_MS, parsed));
    }
    await this.ctx.storage.transaction(async (tx) => {
      const storageKey = `key:${provider}:${key.id}`;
      const state = (await tx.get<KeyState>(storageKey)) ?? {};
      await tx.put(storageKey, { ...state, cooldownUntil: now + duration });
    });
    return duration;
  }

  private async dispatch(query: Query, key: string): Promise<Response> {
    if (query.provider === "semanticscholar") return jsonError(503, "literature provider is disabled", "provider_disabled");
    const keys = await this.poolKeys(query.provider);
    if (keys.length === 0) return jsonError(503, "literature provider is not configured");
    const reservation = await this.reserve(query.provider, keys);
    if (!reservation.ok) {
      if (reservation.reason === "quota") return jsonError(429, "provider daily quota exhausted", "daily_quota");
      return jsonError(429, "provider rate limited", "upstream_rate_limit");
    }
    return this.send(query, key, keys, reservation);
  }

  private async send(query: Query, cacheKey: string, keys: PoolKey[], reservation: Extract<Reservation, { ok: true }>): Promise<Response> {
    const url = new URL(`https://${HOSTS[query.provider]}${query.path}`);
    for (const [name, value] of Object.entries(query.params)) url.searchParams.set(name, value);
    const contact = this.bindings.CROSSREF_EMAIL ? `mailto:${this.bindings.CROSSREF_EMAIL}` : PROJECT_URL;
    const headers = new Headers({ Accept: "application/json, application/x-bibtex;q=0.9", "User-Agent": `Lattice literature proxy/1.0 (${contact})` });
    if (query.provider === "openalex") {
      url.searchParams.set("api_key", reservation.key.secret);
    } else if (query.provider === "crossref" && this.bindings.CROSSREF_EMAIL) {
      url.searchParams.set("mailto", this.bindings.CROSSREF_EMAIL);
    }
    if (query.body) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: query.body ? "POST" : "GET",
        headers,
        body: query.body ? JSON.stringify(query.body) : undefined,
        // Workers supports manual/follow; reject 3xx below without forwarding credentials.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      console.warn("literature fetch failed", query.provider, error instanceof Error ? error.name : "unknown");
      return jsonError(502, "upstream request failed", controller.signal.aborted ? "upstream_timeout" : "upstream_network");
    }
    if (!upstream.ok) {
      clearTimeout(timeout);
      console.warn("literature upstream status", query.provider, upstream.status);
      if (upstream.status === 404) return jsonError(404, "not found");
      if (upstream.status === 429) {
        await this.establishCooldown(query.provider, reservation.key, upstream);
        return jsonError(429, "provider rate limited", "upstream_rate_limit");
      }
      if (upstream.status === 401 || upstream.status === 403) return jsonError(503, "literature provider unavailable", "provider_unauthorized");
      return jsonError(502, "upstream request failed");
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await this.readUpstream(upstream);
    } catch {
      return jsonError(502, "upstream response rejected", controller.signal.aborted ? "upstream_timeout" : "upstream_malformed");
    } finally {
      clearTimeout(timeout);
    }
    const text = new TextDecoder().decode(bytes);
    if (keys.some(({ secret }) => secret && (text.includes(secret) || text.includes(encodeURIComponent(secret))))) return jsonError(502, "upstream response rejected", "upstream_malformed");
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    const response = new Response(bytes, { headers: { "content-type": contentType, "cache-control": "no-store" } });
    this.putCache(cacheKey, bytes, contentType);
    return response;
  }

  private async readUpstream(response: Response): Promise<ArrayBuffer> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_CACHE_BYTES) throw new Error("oversized");
    const reader = response.body?.getReader();
    if (!reader) return new ArrayBuffer(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CACHE_BYTES) {
        await reader.cancel();
        throw new Error("oversized");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  }

  private putCache(key: string, bytes: ArrayBuffer, contentType: string): void {
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes.byteLength;
    this.cache.delete(key);
    this.cache.set(key, { bytes: bytes.slice(0), contentType, expiresAt: Date.now() + 3600_000 });
    this.cacheBytes += bytes.byteLength;
    while (this.cacheBytes > MAX_CACHE_TOTAL_BYTES || this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.entries().next().value as [string, { bytes: ArrayBuffer }] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].bytes.byteLength;
    }
  }
}
