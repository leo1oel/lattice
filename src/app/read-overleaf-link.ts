/** A project's Overleaf link, and whether the signed-in session may use it. */
import { invoke } from "@tauri-apps/api/core";
import type { OverleafLink, OverleafStatus } from "../app-types";
import { overleafLinkMatchesSession } from "../app-utils";
import type { OverleafLinkFor } from "../overleaf/overleaf-connection-store";

/** Always a new object, even when nothing changed: `lastSync` moves on every sync. */
export async function readOverleafLink(root: string): Promise<OverleafLinkFor | null> {
  const [status, link] = await Promise.all([invoke<OverleafStatus>("overleaf_status"), invoke<OverleafLink | null>("overleaf_link")]);
  return link ? {
    root,
    link: { ...link, host: link.host.trim() || status.host.trim() },
    active: status.connected && !link.paused && overleafLinkMatchesSession(status.host, link.host),
  } : null;
}
