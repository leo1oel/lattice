/* eslint-disable react-refresh/only-export-components -- provider and hook form one host seam */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type ProjectImageHostValue = {
  activePath: string;
  loadAsset?: (path: string) => Promise<string | null>;
};

type ProjectImageResource = {
  promise: Promise<string | null>;
  dataUrl?: string | null;
  consumers: number;
};

const PROJECT_IMAGE_CACHE_ENTRY_LIMIT = 48;
const PROJECT_IMAGE_CACHE_CHARACTER_LIMIT = 24 * 1024 * 1024;
const PROJECT_IMAGE_OFFSCREEN_RETENTION_MS = 5_000;

const ProjectImageHostContext = createContext<ProjectImageHostValue>({ activePath: "" });
const projectImageResources = new WeakMap<
  (path: string) => Promise<string | null>,
  Map<string, ProjectImageResource>
>();

function trimProjectImageResources(
  resources: Map<string, ProjectImageResource>,
) {
  let characters = 0;
  for (const resource of resources.values()) characters += resource.dataUrl?.length ?? 0;
  for (const [path, resource] of resources) {
    if (
      resources.size <= PROJECT_IMAGE_CACHE_ENTRY_LIMIT
      && characters <= PROJECT_IMAGE_CACHE_CHARACTER_LIMIT
    ) break;
    // Pending resources are protected while a mounted image awaits them.
    // Once settled, the <img> owns its data URL and the shared cache may evict
    // the entry without making the mounted image disappear.
    if (resource.consumers > 0) continue;
    resources.delete(path);
    characters -= resource.dataUrl?.length ?? 0;
  }
}

function projectImageResource(
  loadAsset: (path: string) => Promise<string | null>,
  projectPath: string,
): ProjectImageResource {
  let resources = projectImageResources.get(loadAsset);
  if (!resources) {
    resources = new Map();
    projectImageResources.set(loadAsset, resources);
  }
  const cached = resources.get(projectPath);
  if (cached) {
    resources.delete(projectPath);
    resources.set(projectPath, cached);
    return cached;
  }
  const resource: ProjectImageResource = {
    consumers: 0,
    promise: loadAsset(projectPath).then((dataUrl) => {
      resource.dataUrl = dataUrl;
      if (resources?.get(projectPath) === resource) {
        resources.delete(projectPath);
        resources.set(projectPath, resource);
        trimProjectImageResources(resources);
      }
      return dataUrl;
    }).catch((error) => {
      if (resources?.get(projectPath) === resource) resources.delete(projectPath);
      throw error;
    }),
  };
  resources.set(projectPath, resource);
  return resource;
}

function cachedProjectImageResource(
  loadAsset: ((path: string) => Promise<string | null>) | undefined,
  projectPath: string | null,
): ProjectImageResource | null {
  if (!loadAsset || !projectPath) return null;
  return projectImageResources.get(loadAsset)?.get(projectPath) ?? null;
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
  const parts = decoded.startsWith("/")
    ? []
    : activePath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
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

export function ProjectImageHostProvider({
  activePath,
  loadAsset,
  children,
}: ProjectImageHostValue & { children: ReactNode }) {
  const value = useMemo(() => ({ activePath, loadAsset }), [activePath, loadAsset]);
  return (
    <ProjectImageHostContext.Provider value={value}>
      {children}
    </ProjectImageHostContext.Provider>
  );
}

export function useProjectImageSrc(src: string | undefined, enabled = true): string | undefined {
  const { activePath, loadAsset } = useContext(ProjectImageHostContext);
  const projectPath = src ? resolveProjectPath(activePath, src) : null;
  const resource = cachedProjectImageResource(loadAsset, projectPath);
  const [loaded, setLoaded] = useState<{
    projectPath: string;
    loader: (path: string) => Promise<string | null>;
    dataUrl: string;
  } | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Keep recently visited media stable during a quick scroll reversal,
      // then release the <img> source so WebKit can discard decoded pixels.
      const timer = setTimeout(() => setLoaded(null), PROJECT_IMAGE_OFFSCREEN_RETENTION_MS);
      return () => clearTimeout(timer);
    }
    if (!projectPath || !loadAsset) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retryDelays = [250, 1_000];
    let releaseCurrent: () => void = () => undefined;
    const load = (attempt: number) => {
      const pendingResource = projectImageResource(loadAsset, projectPath);
      const resources = projectImageResources.get(loadAsset);
      pendingResource.consumers += 1;
      if (resources?.get(projectPath) === pendingResource) {
        resources.delete(projectPath);
        resources.set(projectPath, pendingResource);
      }
      let released = false;
      const releaseResource = () => {
        if (released) return;
        released = true;
        pendingResource.consumers = Math.max(0, pendingResource.consumers - 1);
        if (pendingResource.consumers === 0 && resources?.get(projectPath) === pendingResource) {
          trimProjectImageResources(resources);
        }
      };
      void pendingResource.promise.then((dataUrl) => {
        releaseResource();
        if (active && dataUrl) {
          setLoaded({ projectPath, loader: loadAsset, dataUrl });
          return;
        }
        // Tauri can transiently return null while a newly imported paper
        // asset is still being written. Treat it like a failed read rather
        // than caching a permanent blank image for this document session.
        if (resources?.get(projectPath) === pendingResource) resources.delete(projectPath);
        if (!active || attempt >= retryDelays.length) return;
        retryTimer = setTimeout(() => {
          releaseCurrent = load(attempt + 1);
        }, retryDelays[attempt]);
      }).catch(() => {
        releaseResource();
        if (!active || attempt >= retryDelays.length) return;
        retryTimer = setTimeout(() => {
          releaseCurrent = load(attempt + 1);
        }, retryDelays[attempt]);
      });
      return releaseResource;
    };
    releaseCurrent = load(0);
    return () => {
      active = false;
      releaseCurrent();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [enabled, loadAsset, projectPath]);

  if (!projectPath || !loadAsset) return src;
  if (loaded && loaded.projectPath === projectPath && loaded.loader === loadAsset) {
    return loaded.dataUrl;
  }
  if (!enabled) return undefined;
  return resource?.dataUrl ?? undefined;
}
