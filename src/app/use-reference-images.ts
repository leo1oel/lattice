import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AssetPreview } from "../app-types";
import { referenceAssetPreviewDataUrl } from "../project/reference-preview";
import { onProjectFilesChanged } from "../project/project-files-changed";
import { useRefState } from "./effect-helpers";

type CacheEntry = { promise: Promise<string | null>; characters: number };

const CACHE_ENTRY_LIMIT = 48;
const CACHE_CHARACTER_LIMIT = 24 * 1024 * 1024;

/** Evict least-recently-used entries past the count limit, then past the size limit. */
function trimCache(cache: Map<string, CacheEntry>) {
  for (const [key] of cache) {
    if (cache.size <= CACHE_ENTRY_LIMIT) break;
    cache.delete(key);
  }
  let characters = 0;
  for (const entry of cache.values()) characters += entry.characters;
  for (const [key, entry] of cache) {
    if (characters <= CACHE_CHARACTER_LIMIT) break;
    if (entry.characters === 0) continue;
    cache.delete(key);
    characters -= entry.characters;
  }
}

function normalizeProjectRelativePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

/**
 * Data URLs for images that previews and hover cards reference by project
 * path, cached (LRU, bounded by count and size) per project. `generation`
 * bumps when the watcher reports a change to one of the images handed out, so
 * mounted previews re-request it.
 */
export function useReferenceImages(projectRoot: string | undefined, references: unknown) {
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const loadedRef = useRef({ root: "", paths: new Set<string>() });
  const [generation, , generationRef, setGeneration] = useRefState(0);

  useEffect(() => {
    cacheRef.current.clear();
  }, [projectRoot, references]);

  useEffect(() => {
    if (!projectRoot) return;
    return onProjectFilesChanged(projectRoot, (paths) => {
      const loaded = loadedRef.current;
      const touchesLoadedImage = !paths || paths.some((rawPath) => {
        const changedPath = normalizeProjectRelativePath(rawPath);
        return !changedPath || (loaded.root === projectRoot && [...loaded.paths].some((loadedPath) => (
          loadedPath === changedPath || loadedPath.startsWith(`${changedPath}/`)
        )));
      });
      if (!touchesLoadedImage) return;
      // Relative images can be replaced without changing their path or the
      // surrounding HTML/Markdown. Refresh mounted previews only when the
      // watcher names one of their assets; paper-library and .git churn must
      // not make an unrelated document repaint.
      cacheRef.current.clear();
      setGeneration(generationRef.current + 1);
    });
  }, [generationRef, projectRoot, setGeneration]);

  const load = useCallback((path: string) => {
    const root = projectRoot ?? "";
    const cache = cacheRef.current;
    if (loadedRef.current.root !== root) loadedRef.current = { root, paths: new Set() };
    const normalizedPath = normalizeProjectRelativePath(path);
    if (normalizedPath) loadedRef.current.paths.add(normalizedPath);
    const key = `${root}\0${generationRef.current}\0${path}`;
    const touch = (entry: CacheEntry) => {
      cache.delete(key);
      cache.set(key, entry);
    };
    const cached = cache.get(key);
    if (cached) {
      touch(cached);
      return cached.promise;
    }
    const preview: Promise<string | null> = invoke<AssetPreview>("read_project_asset", { path, projectRoot: root })
      .then(referenceAssetPreviewDataUrl)
      .then((dataUrl) => {
        const current = cache.get(key);
        if (current?.promise !== preview) return dataUrl;
        if (dataUrl === null) {
          // A paper import can expose its Markdown before every extracted
          // asset is readable. Do not memoize that transient miss forever;
          // ProjectImageHost performs a small bounded retry sequence.
          cache.delete(key);
          return dataUrl;
        }
        current.characters = dataUrl.length;
        touch(current);
        trimCache(cache);
        return dataUrl;
      })
      .catch((reason) => {
        if (cache.get(key)?.promise === preview) cache.delete(key);
        throw reason;
      });
    cache.set(key, { promise: preview, characters: 0 });
    trimCache(cache);
    return preview;
  }, [generationRef, projectRoot]);

  return { load, generation };
}
