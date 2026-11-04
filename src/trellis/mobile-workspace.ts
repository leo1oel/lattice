import type { WorkspaceHandle } from "@danfessler/trellis";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { isBrowserHosted } from "../platform/browser-runtime";
import type { TrellisController, TrellisSingleton } from "./trellis-controller";
import { PANEL_TITLES } from "./trellis-titles";

/** Frame one existing panel; keep document/editor/agent hosts and the desktop arrangement intact. */
export function installMobileWorkspace(controller: TrellisController, ws: WorkspaceHandle): () => void {
  const query = window.matchMedia("(max-width: 700px)");
  // React wraps the engine element in .lattice-trellis. The navigation must
  // share the outer workspace's flex column, rather than extend its canvas.
  const host = ws.element.closest<HTMLElement>(".lattice-trellis") ?? ws.element;
  const container = host.parentElement;
  let active = false;
  let previousFrame: string | null = null;
  let lastKey = "";
  let lastReveal = 0;
  let frame = 0;
  const nav = document.createElement("nav");
  nav.className = "mobile-workspace-nav";
  nav.setAttribute("aria-label", i18n._(msg`Workspace panels`));
  const button = (label: string, action: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.onclick = action;
    nav.append(element);
    return element;
  };
  const show = (kind: TrellisSingleton | "editor") => {
    if (kind !== "editor") controller.showPanel(kind);
    const key = controller.app.get().activeKey;
    const view = kind === "editor"
      ? ws.views({ type: "file" }).find((entry) => entry.params.key === key)
      : ws.view(kind);
    if (!view) return;
    ws.focus(view.id);
    ws.navigation.frame(view.panelId);
  };
  button(i18n._(msg`Project`), () => show("project"));
  const editor = button(i18n._(msg`Editor`), () => show("editor"));
  button(i18n._(msg`PDF`), () => show("pdf"));
  const more = document.createElement("select");
  more.setAttribute("aria-label", i18n._(msg`More panels`));
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = i18n._(msg`More`);
  more.append(placeholder);
  for (const kind of ["agent", "terminal", "papers", "git", "history", "overleaf", "literature", "todos", "checklist"] as const) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = i18n._(PANEL_TITLES[kind]);
    more.append(option);
  }
  more.onchange = () => {
    if (more.value) show(more.value as TrellisSingleton);
    more.value = "";
  };
  nav.append(more);
  const save = button(i18n._(msg`Save`), () => { void controller.bridge?.save(); });
  button(i18n._(msg`Build`), () => {
    const key = controller.app.get().activeKey;
    void controller.bridge?.build(key);
  });
  const sync = () => {
    if (!active) return;
    const state = controller.app.get();
    editor.disabled = !state.activeKey;
    save.disabled = !state.activeDirty;
    if (state.activeKey && (state.activeKey !== lastKey || state.revealRequest !== lastReveal)) {
      cancelAnimationFrame(frame);
      // Tab sync installs a newly opened view before this frame runs.
      frame = requestAnimationFrame(() => show("editor"));
    }
    lastKey = state.activeKey;
    lastReveal = state.revealRequest;
  };
  const update = () => {
    const enabled = isBrowserHosted() && query.matches;
    if (enabled === active) return;
    active = enabled;
    if (active) {
      previousFrame = ws.navigation.framed;
      container?.classList.add("mobile-workspace");
      host.after(nav);
      ws.update({ navigation: "focus" });
      show(controller.app.get().activeKey ? "editor" : "project");
      sync();
    } else {
      cancelAnimationFrame(frame);
      nav.remove();
      container?.classList.remove("mobile-workspace");
      ws.update({ navigation: "free" });
      ws.navigation.frame(previousFrame ?? "all");
    }
  };
  query.addEventListener("change", update);
  const unsubscribe = controller.app.subscribe(sync);
  update();
  return () => {
    query.removeEventListener("change", update);
    unsubscribe();
    cancelAnimationFrame(frame);
    nav.remove();
    container?.classList.remove("mobile-workspace");
  };
}
