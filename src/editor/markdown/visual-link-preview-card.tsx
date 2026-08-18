/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/link-preview/use-external-link-preview.ts,
 * packages/app/src/editor/link-preview/ExternalLinkPreviewCard.tsx.
 * Modified 2026-08-04 for Research Writer's local imports and plain strings.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import type { LinkPreviewMetadata } from "../../open-knowledge-core/schemas/api/link-preview.ts";
import { loadLinkPreview } from "./visual-link-preview-data.ts";

export function useExternalLinkPreview({ url, enabled }: { url: string | null; enabled: boolean }) {
  // Bind metadata to its URL because the hover panel can be reused for another
  // link before the previous asynchronous command resolves.
  const [entry, setEntry] = useState<{ url: string; metadata: LinkPreviewMetadata } | null>(null);

  useEffect(() => {
    if (!enabled || !url) return;
    const controller = new AbortController();
    void loadLinkPreview(url, controller.signal).then((result) => {
      if (controller.signal.aborted || !result) return;
      setEntry({ url, metadata: result });
    });
    return () => controller.abort();
  }, [url, enabled]);

  if (!enabled || !url) return null;
  return entry?.url === url ? entry.metadata : null;
}

export function ExternalLinkPreviewCard({ metadata }: { metadata: LinkPreviewMetadata }) {
  const faviconSrc = metadata.faviconDataUri?.startsWith("data:image/")
    ? metadata.faviconDataUri
    : null;

  return (
    <div data-slot="external-link-preview-card" className="mt-2.5 border-t border-border/70 pt-2.5">
      <div className="flex items-center gap-1.5">
        {faviconSrc ? (
          <img data-slot="external-link-preview-favicon" src={faviconSrc} alt="" aria-hidden="true"
            width={16} height={16} className="size-4 shrink-0 rounded-sm" />
        ) : null}
        <span data-slot="external-link-preview-domain"
          className="truncate text-xs font-medium text-muted-foreground">{metadata.domain}</span>
      </div>
      {metadata.title ? (
        <div data-slot="external-link-preview-title"
          className="mt-1 line-clamp-2 text-sm font-medium text-foreground">{metadata.title}</div>
      ) : null}
      {metadata.description ? (
        <p data-slot="external-link-preview-description"
          className="mt-1 line-clamp-3 text-xs text-muted-foreground">{metadata.description}</p>
      ) : null}
    </div>
  );
}
