import { useEffect } from "react";
import { isOpenSlideDeckPath } from "../app-utils";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import type { TrellisController } from "./trellis-controller";

/** How long a heavy panel may be off screen before it unmounts. */
export const HIBERNATE_AFTER_MS = 20_000;

/** Boards, sheets and decks: expensive enough to unmount when their panel is off screen, and never drawn as a text snapshot. */
export function isHeavyDocument(key: string) {
  return key.toLocaleLowerCase().endsWith(".tldr") || isSpreadsheetPath(key) || isOpenSlideDeckPath(key);
}

/**
 * Pause, then unmount, heavy content whose panel is off screen: the PDF after
 * a while hidden, and the active board/sheet likewise (decks hibernate per
 * panel, see DeckSlot). The agent never hibernates; inactive boards and sheets
 * never mount anything heavy to begin with.
 */
export function useHibernation(controller: TrellisController) {
  useEffect(() => {
    let pdfTimer: number | null = null;
    let editorTimer: number | null = null;
    const clear = (timer: number | null) => {
      if (timer !== null) window.clearTimeout(timer);
      return null;
    };
    const update = () => {
      const { present, visible, pdfLive, editorVisible, editorHibernated, switching } = controller.ui.get();
      const pdfShown = Boolean(present.pdf && visible.pdf);
      if (!present.pdf) {
        pdfTimer = clear(pdfTimer);
        if (pdfLive) controller.ui.set({ pdfLive: false });
      } else if (pdfShown) {
        pdfTimer = clear(pdfTimer);
        // Woken after a switch's animation, not in its frames (see beginSwitch).
        if (!pdfLive && !switching) controller.ui.set({ pdfLive: true });
      } else if (pdfLive && pdfTimer === null) {
        pdfTimer = window.setTimeout(() => {
          pdfTimer = null;
          const now = controller.ui.get();
          if (!now.visible.pdf) controller.ui.set({ pdfLive: false });
        }, HIBERNATE_AFTER_MS);
      }
      // Decks keep their own hosts, which hibernate per panel (see DeckSlot).
      const activeKey = controller.app.get().activeKey;
      const heavy = isHeavyDocument(activeKey) && !isOpenSlideDeckPath(activeKey);
      // Boards and sheets zoom themselves on pinch (decks, in their own hosts,
      // likewise); text editors let it zoom the workspace.
      // (A PDF opened here marks its own reader, whether or not the host is marked.)
      controller.hosts.editor.toggleAttribute("data-trellis-owns-gestures", heavy);
      if (!heavy || editorVisible) {
        editorTimer = clear(editorTimer);
        if (editorHibernated) controller.ui.set({ editorHibernated: false });
      } else if (!editorHibernated && editorTimer === null) {
        editorTimer = window.setTimeout(() => {
          editorTimer = null;
          const key = controller.app.get().activeKey;
          if (!controller.ui.get().editorVisible && isHeavyDocument(key) && !isOpenSlideDeckPath(key)) {
            controller.ui.set({ editorHibernated: true });
          }
        }, HIBERNATE_AFTER_MS);
      }
    };
    update();
    const offUi = controller.ui.subscribe(update);
    const offApp = controller.app.subscribe(update);
    return () => {
      offUi();
      offApp();
      clear(pdfTimer);
      clear(editorTimer);
    };
  }, [controller]);
}
