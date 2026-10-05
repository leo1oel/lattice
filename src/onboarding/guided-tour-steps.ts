/**
 * The guided tour's stops through the sample project, in the order of the
 * writing loop: files, the editor and its build, the PDF, layouts, papers,
 * comments and the Agent.
 *
 * Each stop names where it points (`target`, read every frame because panels
 * move), how to bring that place on screen when it is not (`reveal`), and an
 * action to try, with how to tell it was done (`watch`). The tour owns none of
 * these surfaces: it only asks the workspace to show a panel, and watches the
 * stores and DOM events the app already has.
 */
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { TrellisController, TrellisSingleton } from "../trellis/trellis-controller";

/** The sample's manuscript (src-tauri/templates/tutorial/main.tex). */
export const TOUR_MANUSCRIPT = "main.tex";

export type TourContext = {
  controller: TrellisController;
  openFile: (path: string) => void;
  /** Unresolved editor comments, which grow when one is added. */
  commentCount: () => number;
};

export type TourStep = {
  id: string;
  title: MessageDescriptor;
  body: MessageDescriptor;
  /** The action to try, shown with a mark that checks itself once `watch` reports it. */
  action?: MessageDescriptor;
  /** Where the stop points, or null while it is not on screen. Stops without one are centered. */
  target?: (context: TourContext) => DOMRect | null;
  /** Bring the target on screen (open its panel, its document). */
  reveal?: (context: TourContext) => void;
  /** Report `done` once the action happened; returns the cleanup. */
  watch?: (context: TourContext, done: () => void) => () => void;
  /** Leaving the stop: undo what trying it changed that later stops rely on. */
  leave?: (context: TourContext, entered: TourSnapshot) => void;
};

/** What the workspace looked like when a stop was entered. */
export type TourSnapshot = { activeKey: string; preset: string | null; workspace: string };

export function snapshotOf(controller: TrellisController): TourSnapshot {
  const { preset, workspace } = controller.ui.get();
  return { activeKey: controller.app.get().activeKey, preset, workspace };
}

/** A rect is worth pointing at only when enough of it is on screen. */
export function visibleRect(rect: DOMRect | null | undefined): DOMRect | null {
  if (!rect || rect.width < 24 || rect.height < 16) return null;
  if (rect.right < 8 || rect.bottom < 8 || rect.left > window.innerWidth - 8 || rect.top > window.innerHeight - 8) return null;
  return rect;
}

/** The panel holding a singleton view, when that view is the one shown in it. */
function panelOf(controller: TrellisController, kind: TrellisSingleton): DOMRect | null {
  const view = controller.ws?.view(kind);
  if (!view || view.placement === "hidden" || !view.visible) return null;
  return visibleRect(controller.panelRect(kind));
}

function manuscriptPanel(controller: TrellisController): DOMRect | null {
  const view = controller.ws?.views({ type: "file" }).find((item) => item.params.key === TOUR_MANUSCRIPT);
  if (!view || view.placement === "hidden" || !view.selected) return null;
  return visibleRect(controller.panelRect(view.id));
}

function elementRect(selector: string): DOMRect | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = visibleRect(element.getBoundingClientRect());
    if (rect) return rect;
  }
  return null;
}

/** Calls `done` when `select` reads a value other than the one it read first. */
function watchStore<T>(
  store: { get: () => unknown; subscribe: (listener: () => void) => () => void },
  select: () => T,
  done: () => void,
  changed: (first: T, now: T) => boolean = (first, now) => !Object.is(first, now),
) {
  const first = select();
  return store.subscribe(() => {
    if (changed(first, select())) done();
  });
}

/** Calls `done` on a shortcut, wherever focus is (the editor handles it first). */
function watchShortcut(key: string, done: () => void, { shift = false } = {}) {
  const onKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey === shift && event.key.toLowerCase() === key) done();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

/** The welcome for a writer who has walked the tour to its end before. */
export const TOUR_REPLAY_WELCOME = {
  title: msg`Welcome back`,
  body: msg`The same seven stops, for a refresher.`,
} as const;

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    title: msg`Welcome to Lattice`,
    body: msg`A one-minute tour of this sample paper. Seven stops, each with something to try.`,
  },
  {
    id: "project",
    title: msg`Your project`,
    body: msg`Every file of the paper lives here: LaTeX, notes, figures, slides.`,
    action: msg`Open notes.md`,
    target: ({ controller }) => panelOf(controller, "project"),
    reveal: ({ controller }) => controller.showPanel("project", { focus: false }),
    watch: ({ controller }, done) => watchStore(controller.app, () => controller.app.get().activeKey, done),
  },
  {
    id: "write",
    title: msg`Write, then build`,
    body: msg`Edit the LaTeX here. Build typesets it beside you in seconds.`,
    action: msg`Press ⌘S or click Build`,
    target: ({ controller }) => manuscriptPanel(controller),
    reveal: ({ controller, openFile }) => {
      if (controller.app.get().activeKey !== TOUR_MANUSCRIPT || !manuscriptPanel(controller)) openFile(TOUR_MANUSCRIPT);
    },
    watch: ({ controller }, done) => watchStore(
      controller.docTools,
      () => controller.docTools.get(),
      done,
      (first, now) => now.building || now.lastBuild !== first.lastBuild,
    ),
  },
  {
    id: "pdf",
    title: msg`Source and PDF, linked`,
    body: msg`Double-click the PDF to land on its source line. ⌘⇧J jumps back.`,
    action: msg`Double-click a paragraph`,
    target: ({ controller }) => panelOf(controller, "pdf"),
    reveal: ({ controller }) => controller.showPanel("pdf", { focus: false }),
    watch: ({ controller }, done) => {
      const host = controller.hosts.pdf;
      host.addEventListener("dblclick", done);
      const offShortcut = watchShortcut("j", done, { shift: true });
      return () => {
        host.removeEventListener("dblclick", done);
        offShortcut();
      };
    },
  },
  {
    id: "layouts",
    title: msg`Layouts for each task`,
    body: msg`Workspaces keep your panel arrangements. Writing and Reading are ready-made.`,
    action: msg`Switch to Reading`,
    target: () => elementRect(".trellis-titlebar-presets"),
    watch: ({ controller }, done) => watchStore(
      controller.ui,
      () => `${controller.ui.get().preset ?? ""}\n${controller.ui.get().workspace}`,
      done,
    ),
    // The stops after this one point at panels a preset may have parked:
    // put the arrangement back the way it was.
    leave: ({ controller }, entered) => {
      const { preset, workspace } = controller.ui.get();
      if (workspace !== entered.workspace && entered.workspace) controller.switchWorkspace(entered.workspace);
      if (preset !== entered.preset) controller.setPreset(entered.preset as "writing" | "reading" | null);
    },
  },
  {
    id: "papers",
    title: msg`Papers`,
    body: msg`Add papers by arXiv ID, DOI or title, then read them beside your draft.`,
    action: msg`Press ⌘⇧K in the editor to cite one`,
    target: ({ controller }) => panelOf(controller, "papers"),
    reveal: ({ controller }) => controller.showPanel("papers", { focus: false }),
    watch: ({ controller }, done) => {
      const host = controller.hosts.papers;
      host.addEventListener("pointerdown", done);
      const offShortcut = watchShortcut("k", done, { shift: true });
      return () => {
        host.removeEventListener("pointerdown", done);
        offShortcut();
      };
    },
  },
  {
    id: "comments",
    title: msg`Comments`,
    body: msg`Select text in the editor and choose Comment. Every note gathers here.`,
    action: msg`Leave a comment`,
    target: () => elementRect('[data-tour="comments"], .editor-status-bar .status-comments'),
    reveal: ({ controller, openFile }) => {
      if (controller.bridge?.tabKind(controller.app.get().activeKey) !== "file") openFile(TOUR_MANUSCRIPT);
    },
    watch: ({ commentCount }, done) => {
      const first = commentCount();
      const timer = window.setInterval(() => {
        if (commentCount() > first) done();
      }, 250);
      return () => window.clearInterval(timer);
    },
  },
  {
    id: "agent",
    title: msg`The Agent`,
    body: msg`Ask it to explain, revise or check the paper. It works inside your project.`,
    action: msg`Ask it anything`,
    target: ({ controller }) => panelOf(controller, "agent"),
    reveal: ({ controller }) => controller.showPanel("agent", { focus: false }),
    watch: ({ controller }, done) => {
      const host = controller.hosts.agent;
      // The Agent is a frame: typing in it never reaches this document, but
      // focus entering it does.
      const check = () => {
        if (host.contains(document.activeElement)) done();
      };
      host.addEventListener("pointerdown", done);
      window.addEventListener("blur", check);
      host.addEventListener("focusin", check);
      return () => {
        host.removeEventListener("pointerdown", done);
        window.removeEventListener("blur", check);
        host.removeEventListener("focusin", check);
      };
    },
  },
];
