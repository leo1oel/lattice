import { useEffect } from "react";
import type { ViewInfo, WorkspaceHandle } from "@danfessler/trellis-react";
import type { TrellisController } from "./trellis-controller";
import { NAVIGATORS, withDocumentPanel } from "./trellis-workspaces";
import { openDocumentTab } from "./trellis-document-tabs";

/**
 * Keep document panels in step with App's tabs: a tab App opens gets a panel,
 * a tab App closes loses it, and App's active document is the selected tab of
 * its panel. The reverse direction (focus, close) is in the event handlers.
 */
export function useTabSync(controller: TrellisController, ws: WorkspaceHandle | null, quietCloses: { current: Set<string> }) {
  useEffect(() => {
    if (!ws) return;
    let lastActive = "";
    let lastTabsReady = false;
    let lastReveal = controller.app.get().revealRequest;
    const fileViews = () => ws.views({ type: "file" });
    const reconcile = () => {
      const { activeKey, openTabs, tabsReady, revealRequest } = controller.app.get();
      const views = fileViews();
      const byKey = new Map(views.map((view) => [String(view.params.key ?? ""), view]));
      // A new document joins the active document's panel, else an empty
      // document slot on screen, else any document panel; with none left, it gets a panel of its own between
      // the navigators and the rest of the layout.
      //
      // In the Reading layout a document keeps to its side instead: papers
      // join the paper being read (with the library), everything else the
      // notes, and a first note gets a panel of its own beside the paper.
      const anchorPanel = (key: string) => {
        if (controller.ui.get().preset === "reading") {
          const reading = controller.isReading(key);
          const library = ws.view("papers");
          if (reading && library && library.placement !== "hidden") return library.panelId;
          const side = fileViews().find((view) => view.placement !== "hidden" && controller.isReading(String(view.params.key ?? "")) === reading);
          if (side || !reading) return side?.panelId ?? null;
        }
        const current = byKey.get(activeKey);
        if (current && current.placement !== "hidden") return current.panelId;
        const slot = ws.views({ type: "slot" }).find((view) => view.placement !== "hidden");
        if (slot) return slot.panelId;
        return fileViews().find((view) => view.placement !== "hidden")?.panelId ?? null;
      };
      // The writer's open of the active document: a quick look, or another (see trellis-tab-policy.ts).
      const opened = controller.tabs.opening(controller.app.get(), { lastActive, lastReveal, lastTabsReady });
      const open = (key: string) => {
        const panelId = anchorPanel(key);
        let info: ViewInfo | undefined;
        if (panelId) info = openDocumentTab(controller, ws, key, panelId, key === activeKey ? opened : null);
        else {
          const id = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          const navigators = NAVIGATORS.flatMap((kind) => ws.view(kind)?.panelId ?? []);
          // Not animated: this is how the first document appears at startup,
          // and animating the whole layout there costs a frame of work each.
          ws.setDocument(withDocumentPanel(ws.getDocument(), { id, key }, { after: navigators }), { animate: false });
          info = ws.views({ type: "file" }).find((view) => view.id === id);
        }
        if (info) byKey.set(key, info);
        return info ?? null;
      };
      if (tabsReady) {
        for (const view of views) {
          const key = String(view.params.key ?? "");
          if (openTabs.includes(key) || key === activeKey || controller.pendingDrops.has(key)) continue;
          byKey.delete(key);
          quietCloses.current.add(view.id);
          void ws.close(view.id, { force: true });
        }
        for (const key of openTabs) if (!byKey.has(key)) open(key);
      }
      // Selection follows only a change of active document, or an explicit
      // open (which may reopen the active one from a navigator tabbed over
      // it): any other reconcile must leave the panels' own selection alone.
      const activeChanged = activeKey !== lastActive || (tabsReady && !lastTabsReady) || revealRequest !== lastReveal;
      lastActive = activeKey;
      lastTabsReady = tabsReady;
      lastReveal = revealRequest;
      if (!activeKey || !activeChanged) return;
      const info = byKey.get(activeKey) ?? (tabsReady ? open(activeKey) : null);
      if (!info) return;
      if (info.placement === "hidden") ws.focus(info.id);
      else if (!info.selected) {
        // Selecting alone leaves DOM focus on the view it covers, which then
        // hides and drops focus to the body: an Enter on the paper's own
        // library button would strand the keyboard. When focus is still in
        // that covered view, take it along; focus anywhere else (the notes,
        // reached while a paper read was pending) stays where the writer put it.
        const covered = ws.views().find((view) => view.panelId === info.panelId && view.selected);
        const focusedView = document.activeElement?.closest("[data-view]")?.getAttribute("data-view");
        if (covered && focusedView === covered.id) ws.focus(info.id);
        else ws.select(info.id);
      }
      // A camera framing elsewhere hides it: widen the framing to show it,
      // unless the writer has moved on to another document meanwhile.
      requestAnimationFrame(() => {
        if (controller.app.get().activeKey !== activeKey) return;
        const handle = ws.view(info.id);
        if (handle && !handle.visible && handle.placement !== "hidden") ws.focus(info.id);
      });
    };
    const uninstall = controller.installHandlers({ resync: reconcile });
    reconcile();
    const unsubscribe = controller.app.subscribe(reconcile);
    return () => {
      unsubscribe();
      uninstall();
    };
  }, [controller, quietCloses, ws]);
}
