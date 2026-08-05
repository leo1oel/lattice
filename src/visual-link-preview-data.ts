/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original file: packages/app/src/editor/link-preview/external-link-preview.ts.
 * Modified 2026-08-04 for Research Writer's Tauri link-preview command and vendored schema.
 * Licensed under GPL-3.0-or-later.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  type LinkPreviewMetadata,
  LinkPreviewResponseSchema,
} from "./open-knowledge-core/schemas/api/link-preview.ts";

/** Success-cache bound; exported so the eviction test stays in sync. */
export const SUCCESS_CACHE_MAX_ENTRIES = 128;

const successCache = new Map<string, LinkPreviewMetadata>();
const inflight = new Map<string, Promise<LinkPreviewMetadata | null>>();

async function requestLinkPreview(url: string, signal?: AbortSignal): Promise<LinkPreviewMetadata | null> {
  const result: unknown = await invoke("link_preview", { url });
  // Tauri invoke cannot cancel the command, but an obsolete hover must not use
  // or cache metadata that arrives after its caller aborts.
  if (signal?.aborted) return null;
  const parsed = LinkPreviewResponseSchema.safeParse(result);
  if (!parsed.success || !parsed.data.ok) return null;
  return parsed.data.metadata;
}

/**
 * Load preview metadata for an external URL, or `null` on any failure, guard
 * rejection, or abort. Successful results are cached and requests coalesce.
 */
export function loadLinkPreview(url: string, signal?: AbortSignal): Promise<LinkPreviewMetadata | null> {
  const cached = successCache.get(url);
  if (cached) {
    // LRU touch: delete-and-reinsert so the oldest key stays at the Map front.
    successCache.delete(url);
    successCache.set(url, cached);
    return Promise.resolve(cached);
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const metadata = await requestLinkPreview(url, signal);
      if (metadata) {
        successCache.set(url, metadata);
        while (successCache.size > SUCCESS_CACHE_MAX_ENTRIES) {
          const oldest = successCache.keys().next().value;
          if (oldest === undefined) break;
          successCache.delete(oldest);
        }
      }
      return metadata;
    } catch (err) {
      // Command and validation errors are recoverable: nothing is cached, so a
      // later hover retries instead of making a transient failure sticky.
      console.warn(
        "[link-preview] external preview command failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

/** Reset module state so isolated tests never inherit another test's cache. */
export function clearLinkPreviewCaches() {
  successCache.clear();
  inflight.clear();
}
