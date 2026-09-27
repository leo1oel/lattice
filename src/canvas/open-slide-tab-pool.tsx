import { Suspense, useState, type ComponentProps } from "react";
import { useLingui } from "@lingui/react/macro";
import type { FileViewState } from "../app-types";
import { OpenSlideWorkspace } from "./canvas-lazy-editors";

type CachedOpenSlideWorkspace = Omit<ComponentProps<typeof OpenSlideWorkspace>, "active">;

const openSlideSessionKey = (projectRoot: string, path: string) => `${projectRoot}\n${path}`;

/** The sessions to keep: every still-open deck, plus the active one with its view state carried over. */
function reconcileOpenSlideSessions(
  current: Map<string, CachedOpenSlideWorkspace>,
  projectRoot: string,
  activeWorkspace: CachedOpenSlideWorkspace | null,
  openPaths: readonly string[],
  getFileViewState?: (path: string) => FileViewState | undefined,
): Map<string, CachedOpenSlideWorkspace> {
  const next = new Map(current);
  const activeKey = activeWorkspace ? openSlideSessionKey(projectRoot, activeWorkspace.path) : null;
  if (activeWorkspace && activeKey) {
    next.set(activeKey, {
      ...activeWorkspace,
      initialViewState: activeWorkspace.initialViewState
        ?? current.get(activeKey)?.initialViewState
        ?? getFileViewState?.(activeWorkspace.path)?.openSlide,
    });
  }
  const retained = new Set(openPaths.map((path) => openSlideSessionKey(projectRoot, path)));
  for (const key of next.keys()) {
    if (!retained.has(key) && key !== activeKey) next.delete(key);
  }
  return next;
}

/** Keeps every open presentation tab's iframe mounted, showing only the active one. */
export function OpenSlideTabPool({ projectRoot, activeWorkspace, openPaths, getFileViewState }: {
  projectRoot: string;
  activeWorkspace: CachedOpenSlideWorkspace | null;
  openPaths: readonly string[];
  getFileViewState?: (path: string) => FileViewState | undefined;
}) {
  const { t } = useLingui();
  const [cache, setCache] = useState(() => ({
    projectRoot,
    activeWorkspace,
    openPaths,
    sessions: reconcileOpenSlideSessions(new Map(), projectRoot, activeWorkspace, openPaths, getFileViewState),
  }));
  let sessions = cache.sessions;
  if (cache.projectRoot !== projectRoot || cache.activeWorkspace !== activeWorkspace || cache.openPaths !== openPaths) {
    const current = cache.projectRoot === projectRoot ? cache.sessions : new Map();
    sessions = reconcileOpenSlideSessions(current, projectRoot, activeWorkspace, openPaths, getFileViewState);
    setCache({ projectRoot, activeWorkspace, openPaths, sessions });
  }
  // Reconciling always keeps the active deck's session, so it is among these.
  const activeKey = activeWorkspace ? openSlideSessionKey(projectRoot, activeWorkspace.path) : null;
  return (
    <div className="open-slide-tab-pool" data-active={activeKey ? "true" : "false"} aria-hidden={!activeKey}>
      {Array.from(sessions, ([key, workspace]) => {
        const active = key === activeKey;
        return (
          <div key={key} className="open-slide-tab-session" data-active={active ? "true" : "false"}>
            <Suspense
              fallback={active
                ? <div className="open-slide-status" aria-busy="true" aria-label={t`Starting Open Slide`} />
                : null}
            >
              <OpenSlideWorkspace {...workspace} active={active} />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
