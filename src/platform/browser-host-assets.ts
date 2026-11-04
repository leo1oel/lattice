import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import type { BrowserRuntimeConfig } from "./browser-runtime";

/** PDF range transport stays out of the native window's eager startup bundle. */
export async function readAsset(
  range: { path: string; version: string; start: number; end: number },
  session: BrowserRuntimeConfig | null,
  headless: boolean,
  failure: (status?: number) => string,
): Promise<ArrayBuffer> {
  if (headless) {
    const endpoint = new URL("/api/asset", window.location.origin);
    for (const [name, value] of Object.entries(range)) endpoint.searchParams.set(name, String(value));
    const client = (window as Window & { __LATTICE_HEADLESS_CLIENT__?: string }).__LATTICE_HEADLESS_CLIENT__;
    if (client) endpoint.searchParams.set("client", client);
    const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(i18n._(msg`Could not read this asset from the server.`));
    return response.arrayBuffer();
  }
  if (!session) throw new Error(failure());
  const endpoint = new URL(`http://127.0.0.1:${session.bridgePort}/__lattice_asset`);
  for (const [name, value] of Object.entries(range)) endpoint.searchParams.set(name, String(value));
  const response = await fetch(endpoint, { cache: "no-store", headers: { "x-lattice-session": session.token } });
  if (!response.ok) throw new Error(await response.text() || failure(response.status));
  return response.arrayBuffer();
}
