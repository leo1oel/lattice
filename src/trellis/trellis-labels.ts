/**
 * Translations for the strings Trellis draws itself (panel menu items, drop
 * labels, tooltips, screen-reader announcements). The patched core reads
 * `globalThis.__TRELLIS_LABELS__` each time it needs a string, so installing
 * the table again after a language switch is enough.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { spaceMixedScript } from "./trellis-titles";

type Vars = { title?: string; count?: number };

export function installTrellisLabels() {
  const labels: Record<string, (vars: Vars) => string> = {
    addAsTab: () => i18n._(msg`Add as tab`),
    moved: () => i18n._(msg`Moved`),
    releaseToFocus: () => i18n._(msg`Release to focus`),
    releaseToFocusTarget: ({ title = "" }) => spaceMixedScript(i18n._(msg`Release to focus ${title} · Esc to cancel`)),
    unavailable: () => i18n._(msg`Unavailable`),
    workspace: () => i18n._(msg`Workspace`),
    panelMenu: () => i18n._(msg`Panel menu`),
    resizePanels: () => i18n._(msg`Resize panels`),
    closeTab: ({ title = "" }) => spaceMixedScript(i18n._(msg`Close ${title}`)),
    groupPanels: ({ count = 0 }) => i18n._(msg`${count} panels. Double-click to zoom in.`),
    doubleClickToZoomIn: () => i18n._(msg`Double-click to zoom in`),
    restoreSize: () => i18n._(msg`Restore size`),
    maximize: () => i18n._(msg`Maximize`),
    dockBesideStage: () => i18n._(msg`Dock beside documents`),
    dock: () => i18n._(msg`Dock`),
    float: () => i18n._(msg`Float`),
    newSplitRight: () => i18n._(msg`New split right`),
    newSplitBelow: () => i18n._(msg`New split below`),
    moveTo: ({ title = "" }) => spaceMixedScript(i18n._(msg`Move ${title} to`)),
    hide: () => i18n._(msg`Hide`),
    closeView: ({ title = "" }) => spaceMixedScript(i18n._(msg`Close ${title}`)),
    closeOtherTabs: () => i18n._(msg`Close other tabs`),
    theStage: () => i18n._(msg`the documents area`),
    thisGroup: () => i18n._(msg`this group`),
  };
  (globalThis as { __TRELLIS_LABELS__?: typeof labels }).__TRELLIS_LABELS__ = labels;
  // Trellis writes a few labels once, when it creates an element; refresh those
  // in place so a language switch reaches them too.
  for (const element of document.querySelectorAll('.lattice-trellis [data-trellis-part="panel-menu"]')) {
    element.setAttribute("aria-label", labels.panelMenu({}));
  }
  for (const element of document.querySelectorAll('.lattice-trellis [data-trellis-part="snap-preview"] span')) {
    element.textContent = labels.releaseToFocus({});
  }
  for (const element of document.querySelectorAll('.lattice-trellis [data-trellis-part="divider"]')) {
    element.setAttribute("aria-label", labels.resizePanels({}));
  }
}
