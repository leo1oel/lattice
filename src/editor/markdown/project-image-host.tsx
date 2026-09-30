/* eslint-disable react-refresh/only-export-components -- provider and hook form one host seam */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type AssetLoader = (path: string) => Promise<string | null>;

type ProjectImageHostValue = { activePath: string; loadAsset?: AssetLoader; revision: number };
type ProjectImageResource = { promise: Promise<string | null>; dataUrl?: string | null; consumers: number };
type ProjectImageResult = { src: string | undefined; targetExistence: "unknown" | "exists" | "missing" };

const CACHE_ENTRY_LIMIT = 48;
const CACHE_CHARACTER_LIMIT = 24 * 1024 * 1024;
const OFFSCREEN_RETENTION_MS = 5_000;
const RETRY_DELAYS_MS = [250, 1_000];

const ProjectImageHostContext = createContext<ProjectImageHostValue>({ activePath: "", revision: 0 });
/** One LRU cache per loader (a loader identifies a project); Map order is recency. */
const cachesByLoader = new WeakMap<AssetLoader, Map<string, ProjectImageResource>>();
const cacheKey = (revision: number, projectPath: string) => `${revision}\0${projectPath}`;

function cacheFor(loadAsset: AssetLoader): Map<string, ProjectImageResource> {
  let cache = cachesByLoader.get(loadAsset);
  if (!cache) cachesByLoader.set(loadAsset, cache = new Map());
  return cache;
}

/** Mark a still-cached resource most recently used. */
function touch(cache: Map<string, ProjectImageResource>, key: string, resource: ProjectImageResource): boolean {
  if (cache.get(key) !== resource) return false;
  cache.delete(key);
  cache.set(key, resource);
  return true;
}

function trim(cache: Map<string, ProjectImageResource>) {
  let characters = 0;
  for (const resource of cache.values()) characters += resource.dataUrl?.length ?? 0;
  for (const [key, resource] of cache) {
    if (cache.size <= CACHE_ENTRY_LIMIT && characters <= CACHE_CHARACTER_LIMIT) break;
    // Pending resources are protected while a mounted image awaits them.
    // Once settled, the <img> owns its data URL and the shared cache may evict
    // the entry without making the mounted image disappear.
    if (resource.consumers > 0) continue;
    cache.delete(key);
    characters -= resource.dataUrl?.length ?? 0;
  }
}

function projectImageResource(loadAsset: AssetLoader, projectPath: string, revision: number): ProjectImageResource {
  const cache = cacheFor(loadAsset);
  const key = cacheKey(revision, projectPath);
  const cached = cache.get(key);
  if (cached) {
    touch(cache, key, cached);
    return cached;
  }
  const resource: ProjectImageResource = {
    consumers: 0,
    promise: loadAsset(projectPath).then((dataUrl) => {
      resource.dataUrl = dataUrl;
      if (touch(cache, key, resource)) trim(cache);
      return dataUrl;
    }).catch((error) => {
      if (cache.get(key) === resource) cache.delete(key);
      throw error;
    }),
  };
  cache.set(key, resource);
  return resource;
}

function resolveProjectPath(activePath: string, href: string): string | null {
  const rawPath = href.split(/[?#]/, 1)[0];
  if (!rawPath || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  const parts = decoded.startsWith("/") ? [] : activePath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (part === "..") {
      if (!parts.pop()) return null;
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

export function ProjectImageHostProvider({
  activePath,
  loadAsset,
  revision = 0,
  children,
}: Omit<ProjectImageHostValue, "revision"> & { revision?: number; children: ReactNode }) {
  const value = useMemo(() => ({ activePath, loadAsset, revision }), [activePath, loadAsset, revision]);
  return <ProjectImageHostContext.Provider value={value}>{children}</ProjectImageHostContext.Provider>;
}

export function useProjectImage(src: string | undefined, enabled = true): ProjectImageResult {
  const { activePath, loadAsset, revision } = useContext(ProjectImageHostContext);
  const projectPath = src ? resolveProjectPath(activePath, src) : null;
  const [loaded, setLoaded] = useState<{ projectPath: string; loader: AssetLoader; dataUrl: string } | null>(null);
  const [missing, setMissing] = useState<{ projectPath: string; loader: AssetLoader; revision: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Keep recently visited media stable during a quick scroll reversal,
      // then release the <img> source so WebKit can discard decoded pixels.
      const timer = setTimeout(() => setLoaded(null), OFFSCREEN_RETENTION_MS);
      return () => clearTimeout(timer);
    }
    if (!projectPath || !loadAsset) return;
    const cache = cacheFor(loadAsset);
    const key = cacheKey(revision, projectPath);
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseCurrent = () => {};
    const load = (attempt: number) => {
      const resource = projectImageResource(loadAsset, projectPath, revision);
      resource.consumers += 1;
      touch(cache, key, resource);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        resource.consumers = Math.max(0, resource.consumers - 1);
        if (resource.consumers === 0 && cache.get(key) === resource) trim(cache);
      };
      const retryOrGiveUp = () => {
        if (!active) return;
        if (attempt >= RETRY_DELAYS_MS.length) setMissing({ projectPath, loader: loadAsset, revision });
        else retryTimer = setTimeout(() => { releaseCurrent = load(attempt + 1); }, RETRY_DELAYS_MS[attempt]);
      };
      void resource.promise.then((dataUrl) => {
        release();
        if (active && dataUrl) {
          setLoaded({ projectPath, loader: loadAsset, dataUrl });
          setMissing(null);
          return;
        }
        // Tauri can transiently return null while a newly imported paper
        // asset is still being written. Treat it like a failed read rather
        // than caching a permanent blank image for this document session.
        if (cache.get(key) === resource) cache.delete(key);
        retryOrGiveUp();
      }, () => {
        release();
        retryOrGiveUp();
      });
      return release;
    };
    releaseCurrent = load(0);
    return () => {
      active = false;
      releaseCurrent();
      clearTimeout(retryTimer);
    };
  }, [enabled, loadAsset, projectPath, revision]);

  if (!projectPath || !loadAsset) return { src, targetExistence: "unknown" };
  if (missing?.projectPath === projectPath && missing.loader === loadAsset && missing.revision === revision) {
    return { src: undefined, targetExistence: "missing" };
  }
  // Keep the last decoded bytes painted while a replacement at the same path
  // is read. Loader identity still fences project switches, while `revision`
  // only asks for fresher bytes inside that project.
  if (loaded?.projectPath === projectPath && loaded.loader === loadAsset) {
    return { src: loaded.dataUrl, targetExistence: "exists" };
  }
  const cached = enabled ? cachesByLoader.get(loadAsset)?.get(cacheKey(revision, projectPath))?.dataUrl : null;
  return cached ? { src: cached, targetExistence: "exists" } : { src: undefined, targetExistence: "unknown" };
}
