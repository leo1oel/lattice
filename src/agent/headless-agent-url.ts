// Keep postMessage's origin separate from the authenticated proxy route.
const proxies = new Map<string, string>();
export function registerHeadlessAgentProxy(candidate: string | null): void {
  if (!candidate || typeof window === "undefined") return;
  let url: URL;
  try { url = new URL(candidate); } catch { return; }
  if (url.origin !== window.location.origin && url.hostname === window.location.hostname && url.protocol === window.location.protocol && /^\/api\/agent\/[A-Za-z0-9-]{16,64}\/$/.test(url.pathname)
    && !url.username && !url.password && !url.search && !url.hash) proxies.set(url.origin, url.href);
}
export function headlessAgentBase(origin: string): string {
  return proxies.get(origin) ?? origin;
}
