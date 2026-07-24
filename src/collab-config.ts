/**
 * Public Yjs sync host used by Start / Join sharing.
 *
 * Set at build time with VITE_LATTICE_COLLAB_HOST=lattice-collab.<you>.workers.dev
 * After `pnpm collab:deploy` (Wrangler → your Cloudflare account), paste the host
 * into Lattice Advanced, or into `.env.local` for builds.
 *
 * Until then, sharing falls back to localhost:8787 (same machine / LAN only).
 */
/** Fallback when env is unset (your Cloudflare workers.dev deploy). */
const FALLBACK_COLLAB_HOST = "lattice-collab.paperlattice.workers.dev";

export function builtInCollabHost(): string {
  const fromEnv = (import.meta.env.VITE_LATTICE_COLLAB_HOST as string | undefined)?.trim() ?? "";
  const host = (fromEnv || FALLBACK_COLLAB_HOST).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return host;
}

export function isLocalCollabHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost"
    || normalized.startsWith("localhost:")
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.0.0.1:")
    || normalized.startsWith("0.0.0.0:")
    || /^10\.\d+\.\d+\.\d+(:\d+)?$/.test(normalized)
    || /^192\.168\.\d+\.\d+(:\d+)?$/.test(normalized)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+(:\d+)?$/.test(normalized)
  );
}
