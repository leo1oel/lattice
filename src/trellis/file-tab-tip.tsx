/**
 * A document tab's tooltip: the file's place in the project ("chapters/
 * intro.tex"), or a Paper's whole title, which the tab may cut short. Trellis
 * draws the tabs itself, so they cannot be wrapped in a `Tip`; this one
 * tooltip follows the pointer across them instead, with the same look and the
 * same timing (`TIP_DELAY`: the pointer rests before the first shows, and the
 * next tab's shows at once while it moves along the strip). The `file` view
 * type opts out of Trellis's native `title` (`tip={false}`), so the two never
 * show together.
 */
import { useEffect, useReducer } from "react";
import type { WorkspaceHandle } from "@danfessler/trellis";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TIP_DELAY } from "../components/tip-delay";
import { isPaperTabKey } from "../app-utils";
import type { TrellisController } from "./trellis-controller";

type Shown = { text: string; left: number; top: number; width: number; height: number };

const FILE_TAB = '[data-trellis-part="tab"][data-type="file"]';

/** What document `key`'s tab says on hover. */
function fileTabTipText(controller: TrellisController, key: string): string {
  return isPaperTabKey(key) ? controller.bridge?.tabLabel(key) ?? "" : key;
}

export function FileTabTip({ controller, ws }: { controller: TrellisController; ws: WorkspaceHandle | null }) {
  const [shown, setShown] = useReducer((_: Shown | null, next: Shown | null) => next, null);
  useEffect(() => {
    if (!ws) return;
    const root = ws.element;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The tab under the pointer. A press on it (a click, a drag, a right
    // click's menu) puts its tip away until the pointer leaves it, as Radix does.
    let hovered: HTMLElement | null = null;
    let open = false;
    let closedAt = Number.NEGATIVE_INFINITY;
    const close = () => {
      clearTimeout(timer);
      if (open) closedAt = performance.now();
      open = false;
      setShown(null);
    };
    const show = (tab: HTMLElement) => {
      const view = tab.dataset.view ? ws.view(tab.dataset.view) : null;
      const text = view ? fileTabTipText(controller, String(view.params.key ?? "")) : "";
      if (!text || !tab.isConnected) return;
      const rect = tab.getBoundingClientRect();
      open = true;
      setShown({ text, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    const onPointerOver = (event: PointerEvent) => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLElement>(FILE_TAB) : null;
      if (tab === hovered) return;
      const wasOpen = open;
      close();
      hovered = tab;
      if (!tab || event.buttons) return;
      // Moving along the strip from one tab's tip, the next shows at once.
      const skip = wasOpen || performance.now() - closedAt < TIP_DELAY.skipDelayDuration;
      if (skip) show(tab);
      else timer = setTimeout(() => show(tab), TIP_DELAY.delayDuration);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!hovered) return;
      const into = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (into && hovered.contains(into)) return;
      hovered = null;
      close();
    };
    const onPress = () => {
      if (hovered) close();
    };
    root.addEventListener("pointerover", onPointerOver, true);
    root.addEventListener("pointerout", onPointerOut, true);
    root.addEventListener("pointerdown", onPress, true);
    root.addEventListener("contextmenu", onPress, true);
    root.addEventListener("wheel", onPress, { capture: true, passive: true });
    // A tab that closes or moves takes its tip with it.
    const offChange = ws.on("change", close);
    const offClose = ws.on("close", close);
    return () => {
      clearTimeout(timer);
      root.removeEventListener("pointerover", onPointerOver, true);
      root.removeEventListener("pointerout", onPointerOut, true);
      root.removeEventListener("pointerdown", onPress, true);
      root.removeEventListener("contextmenu", onPress, true);
      root.removeEventListener("wheel", onPress, true);
      offChange();
      offClose();
      setShown(null);
    };
  }, [controller, ws]);

  // Radix places the tip against its trigger: a box laid over the tab, which
  // takes no pointer events, so the tab underneath keeps every one of them.
  return (
    <TooltipProvider>
      <Tooltip open={Boolean(shown)} onOpenChange={(next) => { if (!next) setShown(null); }}>
        <TooltipTrigger asChild>
          <span
            aria-hidden="true"
            data-file-tab-tip-anchor=""
            style={{
              position: "fixed",
              left: shown?.left ?? 0,
              top: shown?.top ?? 0,
              width: shown?.width ?? 0,
              height: shown?.height ?? 0,
              pointerEvents: "none",
            }}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="font-medium" data-file-tab-tip="">
          {shown?.text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
