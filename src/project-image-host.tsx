/* eslint-disable react-refresh/only-export-components -- provider and hook form one host seam */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type ProjectImageHostValue = {
  activePath: string;
  loadAsset?: (path: string) => Promise<string | null>;
};

type ProjectImageResource = {
  promise: Promise<string | null>;
  dataUrl?: string;
};

const ProjectImageHostContext = createContext<ProjectImageHostValue>({ activePath: "" });
const projectImageResources = new WeakMap<
  (path: string) => Promise<string | null>,
  Map<string, ProjectImageResource>
>();

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
  if (cached) return cached;
  const resource: ProjectImageResource = {
    promise: loadAsset(projectPath).then((dataUrl) => {
      if (dataUrl) resource.dataUrl = dataUrl;
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

export function useProjectImageSrc(src: string | undefined): string | undefined {
  const { activePath, loadAsset } = useContext(ProjectImageHostContext);
  const projectPath = src ? resolveProjectPath(activePath, src) : null;
  const resource = cachedProjectImageResource(loadAsset, projectPath);
  const [loaded, setLoaded] = useState<{
    projectPath: string;
    loader: (path: string) => Promise<string | null>;
    dataUrl: string;
  } | null>(null);

  useEffect(() => {
    if (!projectPath || !loadAsset || resource?.dataUrl) return;
    const pendingResource = resource ?? projectImageResource(loadAsset, projectPath);
    let active = true;
    void pendingResource.promise.then((dataUrl) => {
      if (active && dataUrl) setLoaded({ projectPath, loader: loadAsset, dataUrl });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [loadAsset, projectPath, resource]);

  if (resource?.dataUrl) return resource.dataUrl;
  return loaded && loaded.projectPath === projectPath && loaded.loader === loadAsset
    ? loaded.dataUrl
    : src;
}
