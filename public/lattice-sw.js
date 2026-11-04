// A network-only app: never persist project files, API responses, sessions,
// HTML (which may contain runtime configuration), or credentials in CacheStorage.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    "<!doctype html><html lang=en><meta name=viewport content='width=device-width,initial-scale=1'><title>Lattice offline</title><body><h1>Server unavailable</h1><p>Reconnect to your private network and reload to continue editing.</p><button onclick='location.reload()'>Reload</button></body></html>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  )));
});
