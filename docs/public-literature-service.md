# Public literature service

The `lattice-literature` Cloudflare Worker is independent of `lattice-collab`.
Its public endpoint is `https://lattice-literature.paperlattice.workers.dev/v1/query`.
Desktop builds use this endpoint for OpenAlex and Crossref fallback requests.
Semantic Scholar is personal-key-only and is never proxied by this service.
Previously installed desktop releases do not gain this routing just because the Worker is deployed.

## Manage credentials

Open Cloudflare → Workers & Pages → `lattice-literature` → Settings → Variables and Secrets.
Store credential values as **Secrets**, never plaintext build variables or `VITE_` variables:

| Secret | Format | Selection |
| --- | --- | --- |
| `OPENALEX_API_KEYS` | JSON array of strings | Selects the least recently reserved healthy key. |
| `CROSSREF_EMAIL` | One real contact email | Sent to Crossref's polite pool. |

To rotate a key, replace its Secret value and deploy the updated configuration in Cloudflare.
No desktop update is needed for a key rotation.
Only provision credentials the providers have issued for this application; the pool does not create credentials.
Obtain provider approval for the application's shared use and quota rather than assuming multiple keys increase an account's aggregate permitted throughput.
Rotate any credential exposed in chat, screenshots, or terminal history.

Alternatively, from `collab-server`, these commands prompt for values without putting them in command arguments:

```sh
pnpm exec wrangler secret put OPENALEX_API_KEYS --config wrangler.literature.jsonc
pnpm exec wrangler secret put CROSSREF_EMAIL --config wrangler.literature.jsonc
```

## Requests and limits

`POST /v1/query` accepts `{provider, path, params, body?}`.
Only allowlisted OpenAlex works and Crossref works operations are forwarded.
Semantic Scholar requests from older clients receive HTTP 503 with stable code `provider_disabled`, even if stale Semantic Scholar secrets remain in the deployed Worker environment.
Users who enable Semantic Scholar must configure their own client key; the public service never receives or supplies it.
The upstream host is fixed by the provider; callers cannot choose an arbitrary forwarding URL or retrieve keys.
Successful responses retain the upstream JSON or BibTeX shape.
Google Scholar scraping is removed in bibcite 0.6.4, and Unpaywall is removed in 0.6.5.
DBLP still executes locally, with single-attempt requests, a shared four-second scheduling budget for exact/fuzzy lookup, and BibTeX built from its search response instead of another export request.
Network timeouts apply per phase, so this budget is not a strict wall-clock limit.

The default safeguards are:

- 60 requests per minute per IP at the edge, plus global durable daily budgets of 5,000 upstream requests for each forwarded provider.
- OpenAlex selects the least recently reserved available key, and a 429 cools down only that key using bounded `Retry-After` values so another healthy key remains eligible.
- At most 40 distinct upstream requests in flight, with identical requests coalesced inside the Durable Object.
- Successful metadata cached for one hour, bounded to 128 entries and 16 MiB; each response is capped at 1 MiB.
- Requests are capped at 16 KiB, and result limits are capped at 100.

Daily counters survive Worker restarts; the response cache is in memory and can be lost when the object is evicted or redeployed.
The two `*_DAILY_QUOTA` variables in `wrangler.literature.jsonc` are application safety budgets, not promises about the providers' own quotas.
Anonymous IP limits do not authenticate desktop installations or prevent all abuse; the global budgets bound upstream consumption if third parties call the endpoint.
Native and CLI fallback paths may still use other providers after a public lookup fails, so this is not a claim that the entire citation workflow is retry-free.

## Deploy and verify

From `collab-server`:

```sh
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --config wrangler.literature.jsonc
curl https://lattice-literature.paperlattice.workers.dev/health
```

`/health` reports configuration booleans, not whether the provider accepts a key, and always reports `configured.semanticscholar` as `false` for compatibility.
Verify a real request after changing credentials:

```sh
curl https://lattice-literature.paperlattice.workers.dev/v1/query \
  -H 'Content-Type: application/json' \
  --data '{"provider":"openalex","path":"/works","params":{"search":"Attention Is All You Need","per_page":"1","select":"id,title,doi"}}'
```

The service receives search terms, DOI/arXiv identifiers, and the caller's IP address; it does not receive project files or personal API keys.
Application warning logs contain provider names, status codes, or error classes only, not query strings, upstream bodies, or credentials.
Cloudflare's platform request metadata remains subject to the account's logging settings.
For a self-hosted fork, deploy this Worker in your account and change `literature_service::ENDPOINT`; native calls and the bibcite environment use that one endpoint.
