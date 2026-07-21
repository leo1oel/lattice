# Lattice collab server

Yjs sync room on **your own Cloudflare account** (`*.workers.dev`).

The old `partykit deploy` path hits a shared `partykit.dev` domain quota and fails for everyone — do not use it.

## One-time setup

```bash
cd /Users/leonardo/CascadeProjects/research-writer
pnpm collab:login    # opens Cloudflare in the browser (once)
pnpm collab:deploy
```

Or from `collab-server/`:

```bash
pnpm run login
pnpm run deploy
```

Wrangler prints a host like:

`lattice-collab.<your-subdomain>.workers.dev`

Then in Lattice: **Live collaboration → Advanced (sync host)** → paste that host (no `https://`) → **Start sharing**.

Optional: bake it into builds:

```bash
# repo root .env.local
VITE_LATTICE_COLLAB_HOST=lattice-collab.<your-subdomain>.workers.dev
```

## Local test

```bash
pnpm --dir collab-server dev
```

Default local host is usually `localhost:8787` (Wrangler). Put that under Advanced if needed.

## Everyday app flow

1. You: Start sharing → invite copied  
2. Friend: Join → paste invite → Join share  
3. Success: both show **Sharing · 2 connected** and typing syncs  
