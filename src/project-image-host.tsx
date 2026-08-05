/* eslint-disable react-refresh/only-export-components -- provider and hook form one host seam */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type ProjectImageHostValue = {
  activePath: string;
  loadAsset?: (path: string) => Promise<string | null>;
};

const ProjectImageHostContext = createContext<ProjectImageHostValue>({ activePath: "" });

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
  return (
    <ProjectImageHostContext.Provider value={{ activePath, loadAsset }}>
      {children}
    </ProjectImageHostContext.Provider>
  );
}

export function useProjectImageSrc(src: string | undefined): string | undefined {
  const { activePath, loadAsset } = useContext(ProjectImageHostContext);
  const [loaded, setLoaded] = useState<{
    source: string;
    loader: (path: string) => Promise<string | null>;
    dataUrl: string;
  } | null>(null);

  useEffect(() => {
    if (!src || !loadAsset) return;
    const projectPath = resolveProjectPath(activePath, src);
    if (!projectPath) return;
    let active = true;
    void loadAsset(projectPath).then((dataUrl) => {
      if (active && dataUrl) setLoaded({ source: src, loader: loadAsset, dataUrl });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [activePath, loadAsset, src]);

  return loaded && loaded.source === src && loaded.loader === loadAsset ? loaded.dataUrl : src;
}
