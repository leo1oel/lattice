# Lattice literature Worker

The `lattice-literature` Cloudflare Worker: the public OpenAlex and Crossref
proxy that desktop builds fall back to for literature lookups. Credentials,
limits, deployment and verification are in
[`docs/public-literature-service.md`](../docs/public-literature-service.md).

## Checks

This is a separate pnpm project with its own lockfile, so the root `pnpm install`
does not cover it:

```bash
pnpm --dir literature-worker install --frozen-lockfile
pnpm --dir literature-worker typecheck
pnpm --dir literature-worker test
```

`pnpm check` at the repository root already runs the last two as its
`literature-worker` stage, so you only need them by hand when iterating. The
tests run on `@cloudflare/vitest-pool-workers`, which starts a local `workerd`
and simulates the Durable Object and rate-limit bindings declared in
`wrangler.jsonc` — no Cloudflare account or `wrangler login` is involved. Only
`pnpm run deploy` needs credentials.
