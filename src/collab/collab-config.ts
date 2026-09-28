/**
 * Public Yjs sync host used by Start / Join sharing.
 *
 * Set at build time with VITE_LATTICE_COLLAB_HOST=lattice-collab.<you>.workers.dev
 * After `pnpm collab:deploy` (Wrangler → your Cloudflare account), set the host
 * in `.env.local` for builds.
 */
/**
 * Fallback when VITE_LATTICE_COLLAB_HOST is unset.
 *
 * MAINTAINER-OPERATED INFRASTRUCTURE. This Cloudflare Worker is deployed to,
 * paid for, and administered by the maintainer of this repository. It is not a
 * neutral or hosted-for-you service and carries no uptime, retention, or
 * privacy guarantee.
 *
 * Every build that does not set VITE_LATTICE_COLLAB_HOST — including forks,
 * unmodified dev builds, and CI — relays live collaboration traffic through it:
 * shared document text, file names and paths, shared assets, project chat and
 * comments, and presence (cursor position and display name). Projects that are
 * not actively shared never contact it.
 *
 * Forks and self-hosters: run `pnpm collab:deploy` against your own Cloudflare
 * account and set VITE_LATTICE_COLLAB_HOST (see .env.example and
 * collab-server/README.md). Users can also override it at runtime under
 * Live collaboration → Advanced (sync host).
 */
const FALLBACK_COLLAB_HOST = "lattice-collab.paperlattice.workers.dev";

function builtInCollabHost(): string {
  const fromEnv = (import.meta.env.VITE_LATTICE_COLLAB_HOST as string | undefined)?.trim() ?? "";
  return normalizeCollabHost(fromEnv || FALLBACK_COLLAB_HOST);
}

// v2: the old key persisted the built-in host, which pinned users to whatever
// it was that day and blocked later built-in changes (e.g. the sync-host move)
// from reaching them. Bumping the key retires those stale values; we now only
// store a genuine custom override.
const HOST_STORAGE_KEY = "lattice.collab.host.v2";
const NAME_STORAGE_KEY = "lattice.collab.name";

/** `host[:port]`, without scheme or trailing slashes. */
export function normalizeCollabHost(raw: string): string {
  return raw.trim().replace(/^(https?|wss?):\/\//i, "").replace(/\/+$/, "");
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, quota): the setting just does not persist.
  }
}

/** The sync host to use: an explicit one, else the stored override, else the built-in. */
export function resolveCollabHost(preferred?: string): string {
  const explicit = normalizeCollabHost(preferred ?? "");
  if (explicit) return explicit;
  const builtIn = builtInCollabHost();
  const stored = normalizeCollabHost(readStorage(HOST_STORAGE_KEY));
  // A stored local host from development never shadows a deployed built-in.
  if (stored && !(builtIn && isLocalCollabHost(stored) && !isLocalCollabHost(builtIn))) return stored;
  return builtIn || stored || "localhost:8787";
}

export function saveCollabHost(host: string): void {
  const normalized = normalizeCollabHost(host);
  // Only persist a genuine custom override. Storing the built-in host would
  // pin the user to today's value, so a later change to the built-in (e.g. a
  // new sync host) could never reach them — exactly the bug v2 retires.
  writeStorage(HOST_STORAGE_KEY, !normalized || normalized === builtInCollabHost() ? null : normalized);
}

export const loadCollabDisplayName = () => readStorage(NAME_STORAGE_KEY);
export const saveCollabDisplayName = (name: string) => writeStorage(NAME_STORAGE_KEY, name);

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
