/**
 * External link metadata for the link hover card (spec R-CHR-4), fetched
 * through the host's `link_preview` command. Successes are kept in a small
 * LRU cache; concurrent requests for one URL share a single fetch; a blocked
 * or malformed answer, or an aborted request, yields nothing and is not
 * cached.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { invoke } from "@tauri-apps/api/core";

export type LinkMetadata = {
  domain: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** Shown only as a `data:` URI; a remote favicon is never loaded. */
  faviconDataUri?: string;
};

export const PREVIEW_CACHE_LIMIT = 64;

const successes = new Map<string, LinkMetadata>();
const pending = new Map<string, Promise<LinkMetadata | null>>();

export function clearLinkPreviews() {
  successes.clear();
  pending.clear();
}

function rememberPreview(url: string, metadata: LinkMetadata) {
  successes.delete(url);
  successes.set(url, metadata);
  while (successes.size > PREVIEW_CACHE_LIMIT) successes.delete(successes.keys().next().value!);
}

function validMetadata(value: unknown): LinkMetadata | null {
  const answer = value as { ok?: unknown; metadata?: Partial<LinkMetadata> } | null;
  if (!answer || answer.ok !== true || !answer.metadata || typeof answer.metadata.domain !== "string" || !answer.metadata.domain) return null;
  return answer.metadata as LinkMetadata;
}

/** Metadata for `url`, or null when it cannot be had (blocked, malformed, aborted). */
export function loadLinkPreview(url: string, signal?: AbortSignal): Promise<LinkMetadata | null> {
  const cached = successes.get(url);
  if (cached) {
    rememberPreview(url, cached);
    return Promise.resolve(cached);
  }
  let request = pending.get(url);
  if (!request) {
    request = invoke<unknown>("link_preview", { url })
      .then((value) => {
        const metadata = validMetadata(value);
        if (metadata) rememberPreview(url, metadata);
        return metadata;
      })
      .catch(() => null)
      .finally(() => pending.delete(url));
    pending.set(url, request);
  }
  if (!signal) return request;
  return new Promise((resolve) => {
    const abort = () => resolve(null);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    void request.then((metadata) => {
      signal.removeEventListener("abort", abort);
      resolve(signal.aborted ? null : metadata);
    });
  });
}
