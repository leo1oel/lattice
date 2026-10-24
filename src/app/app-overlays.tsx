/**
 * What App shows over the welcome screen and a project alike: the interface
 * size HUD and What's new.
 */
import { lazy, memo, Suspense } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toMessage } from "../app-utils";
import { InterfaceZoomHud as InterfaceZoomPill } from "./interface-zoom-hud";
import { showError } from "./notify";
import type { useInterfaceZoom } from "./use-interface-zoom";
import type { useWhatsNew } from "./use-whats-new";

// Memoized: its props are stable, and App re-renders on every keystroke.
const InterfaceZoomHud = memo(InterfaceZoomPill);
const WhatsNewDialog = lazy(() => import("./whats-new-dialog").then((module) => ({ default: module.WhatsNewDialog })));

export function AppOverlays({ interfaceScale, interfaceZoom, whatsNew }: {
  interfaceScale: number;
  interfaceZoom: ReturnType<typeof useInterfaceZoom>;
  whatsNew: ReturnType<typeof useWhatsNew>;
}) {
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
    </>
  );
}
