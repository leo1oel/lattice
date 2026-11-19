/**
 * What App shows over the welcome screen and a project alike: the interface
 * size HUD, What's new, Clone repository and the recent-project finder.
 */
import { lazy, memo, Suspense } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toMessage } from "../app-utils";
import { InterfaceZoomHud as InterfaceZoomPill } from "./interface-zoom-hud";
import { showError } from "./notify";
import type { useInterfaceZoom } from "./use-interface-zoom";
import type { useProjectLifecycle } from "./use-project-lifecycle";
import type { useWhatsNew } from "./use-whats-new";

// Memoized: its props are stable, and App re-renders on every keystroke.
const InterfaceZoomHud = memo(InterfaceZoomPill);
const WhatsNewDialog = lazy(() => import("./whats-new-dialog").then((module) => ({ default: module.WhatsNewDialog })));
const CloneRepositoryDialog = lazy(() => import("../project/clone-repository-dialog").then((module) => ({ default: module.CloneRepositoryDialog })));
const RecentProjectFinder = lazy(() => import("../project/recent-project-finder").then((module) => ({ default: module.RecentProjectFinder })));

export function AppOverlays({ interfaceScale, interfaceZoom, whatsNew, lifecycle, currentPath }: {
  interfaceScale: number;
  interfaceZoom: ReturnType<typeof useInterfaceZoom>;
  whatsNew: ReturnType<typeof useWhatsNew>;
  lifecycle: Pick<ReturnType<typeof useProjectLifecycle>, "clone" | "recentFinder" | "recentProjects" | "chooseRecentProject">;
  /** The project this window shows, which the finder leaves out. */
  currentPath: string | undefined;
}) {
  const { clone, recentFinder } = lifecycle;
  return (
    <>
      <InterfaceZoomHud scale={interfaceScale} revealKey={interfaceZoom.revealKey} onChange={interfaceZoom.zoom} />
      {whatsNew.open && (
        <Suspense fallback={null}>
          <WhatsNewDialog
            open
            onClose={() => whatsNew.setOpen(false)}
            onOpenUrl={(url) => void openUrl(url).catch((reason: unknown) => showError(toMessage(reason)))}
          />
        </Suspense>
      )}
      {clone.open && (
        <Suspense fallback={null}>
          <CloneRepositoryDialog recentProjectPath={clone.recentProjectPath} onClose={clone.close} onCloned={clone.opened} />
        </Suspense>
      )}
      {recentFinder.open && (
        <Suspense fallback={null}>
          <RecentProjectFinder
            projects={lifecycle.recentProjects}
            currentPath={currentPath}
            onClose={recentFinder.close}
            onOpen={(path) => void lifecycle.chooseRecentProject(path)}
          />
        </Suspense>
      )}
    </>
  );
}
