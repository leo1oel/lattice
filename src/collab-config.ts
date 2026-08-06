/**
 * Public Yjs sync host used by Start / Join sharing.
 *
 * Set at build time with VITE_LATTICE_COLLAB_HOST=lattice-collab.<you>.workers.dev
 * After `pnpm collab:deploy` (Wrangler → your Cloudflare account), set the host
 * in `.env.local` for builds.
 */
/** Fallback when env is unset (your Cloudflare workers.dev deploy). */
const FALLBACK_COLLAB_HOST = "lattice-collab.paperlattice.workers.dev";

export function builtInCollabHost(): string {
  const fromEnv = (import.meta.env.VITE_LATTICE_COLLAB_HOST as string | undefined)?.trim() ?? "";
  const host = (fromEnv || FALLBACK_COLLAB_HOST).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return host;
}

/**
 * Origin the control plane, binary uploads, and invitations address.
 *
 * A `wrangler dev` server speaks plain HTTP, so forcing `https://` on a local
 * host fails the TLS handshake before the request leaves the WebView ("Load
 * failed") and the documented local-test flow can never reach the Worker. The
 * scheme therefore tracks what the Yjs transport already does: `y-partyserver`
 * picks `ws://` for exactly this set of hosts and `wss://` for the rest, so the
 * two planes agree on whether a deployment is local.
 */
export function collabDeploymentOrigin(host: string): string {
  const raw = host.trim();
  if (raw.includes("://")) return new URL(raw).origin;
  return new URL(`${isLocalCollabHost(raw) ? "http" : "https"}://${raw}`).origin;
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
