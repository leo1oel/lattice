/** Only a standalone server has a stable same-origin entry; native handoff links are single-use. */
export async function registerWebApp(): Promise<void> {
  const runtime = window as Window & { __LATTICE_HEADLESS__?: boolean };
  if (!runtime.__LATTICE_HEADLESS__ || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  const base = import.meta.env.BASE_URL;
  await navigator.serviceWorker.register(`${base}lattice-sw.js`, { scope: base, updateViaCache: "none" });
}
