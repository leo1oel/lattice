/**
 * The window title bar: the project switcher over the left column (with
 * two projects in the window, their tabs: project-tabs.tsx), then the
 * panel controls and the project-wide tools (comments, Overleaf, Git,
 * history). A document's own actions (Build, Edit / Split /
 * Preview) live in its panel's header instead.
 *
 * In focus mode the bar keeps only the window's own controls and `focusBar`
 * (the document's name and the way out): nothing else of the chrome.
 *
 * The canvas toolbar arrives as an element rather than as props. It reads about
 * fifty of App's values — collaboration presence, Overleaf channel state, the
 * dirty flag of the active document — and none of the rest of the title bar
 * needs any of them, so pulling them through here would double the interface
 * for a component that only ever gets slotted into one place.
 */
import { Suspense, type ReactNode, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { chunk, lazyChunk } from "../lib/lazy-chunk";
import { LazyMount } from "../components/lazy-mount";
import { beginWindowDrag, titleBarDoubleClick } from "../app-utils";
import type { ProjectSnapshot } from "../app-types";
import type { OpenDocuments } from "./use-open-documents";
import type { useProjectLifecycle } from "./use-project-lifecycle";
import { useWindowProjects } from "./window-projects";
import { useWindowTitle } from "./use-native-window";
import { cn } from "@/lib/utils";
import { baseName } from "../lib/base-name";

const loadProjectTabs = chunk(() => import("./project-tabs"));
const ProjectTabs = lazyChunk(loadProjectTabs, (module) => module.default);
const loadProjectMenu = chunk(() => import("../project/project-menu"));
const ProjectMenu = lazyChunk(loadProjectMenu, (module) => module.ProjectMenu);
// Fetched as the pointer or the keyboard reaches the title, so the menu is in
// by the time it opens, and the tabs by the time it opens a second project here.
const warmProjectMenu = () => {
  void loadProjectMenu();
  void loadProjectTabs();
};

export function AppTitlebar({ project, documents, projectMenu, panelControls, canvasToolbar, focusBar }: {
  project: ProjectSnapshot;
  /** The file or Paper in front, whose name the window's title and the focus bar carry. */
  documents: Pick<OpenDocuments, "paper" | "activeTab">;
  /** The project switcher's menu (the lifecycle's projects and actions, and App's dialogs), and what may disable it. */
  projectMenu: {
    lifecycle: Pick<
      ReturnType<typeof useProjectLifecycle>,
      | "projectMenuOpen" | "setProjectMenuOpen" | "recentProjects" | "busyLabel" | "chooseRecentProject" | "chooseExisting"
      | "clone" | "openTutorialProject" | "exportProjectZip" | "openInThisWindow" | "openProjectWindow"
    >;
    onNew: () => void;
    onOpenOverleaf: () => void;
    onExportArxiv: () => void;
    /** Settings, opened from the menu, returns focus to `returnFocus`: the menu's trigger. */
    onSettings: (returnFocus: HTMLElement | null) => void;
    importing: boolean;
    building: boolean;
  };
  /** The Panels menu, the layout switch, search and the hidden-panel chips. */
  panelControls: ReactNode;
  canvasToolbar: ReactNode;
  /** Focus mode's bar, given the front document's name, which stands in for everything after the traffic lights. */
  focusBar?: (documentTitle: string) => ReactNode;
}) {
  const { t } = useLingui();
  const { lifecycle, importing, building, onSettings, onNew, onOpenOverleaf, onExportArxiv } = projectMenu;
  const projects = useWindowProjects();
  // The menu item that opens Settings closes with the menu, so Settings is
  // handed the trigger to return focus to instead.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const projectName = project.manifest.name;
  const documentTitle = documents.paper?.title ?? baseName(documents.activeTab);
  // Project first: where the system shortens a title, the project is what tells windows apart.
  useWindowTitle(documentTitle ? t`${projectName} — ${documentTitle}` : projectName);
  // The website's demo is a page in a browser tab: no window controls to make room for.
  const bar = cn("titlebar", import.meta.env.LATTICE_WEB_DEMO && "titlebar-without-lights");
  if (focusBar) {
    return (
      <header className={cn(bar, "titlebar-focus")} onMouseDown={beginWindowDrag} onDoubleClick={titleBarDoubleClick}>
        <div className="traffic-space" />
        {focusBar(documentTitle)}
      </header>
    );
  }
  const projectTitle = (
    <DropdownMenu open={lifecycle.projectMenuOpen} onOpenChange={lifecycle.setProjectMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          className="project-title"
          aria-label={t`Switch project`}
          disabled={building || importing}
          onPointerEnter={warmProjectMenu}
          onFocus={warmProjectMenu}
        >
          <span>{projectName}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <LazyMount when={lifecycle.projectMenuOpen}>
        <ProjectMenu
          currentPath={project.root} recentProjects={lifecycle.recentProjects} busyLabel={lifecycle.busyLabel}
          onRecent={lifecycle.chooseRecentProject} onOpen={lifecycle.chooseExisting} onNew={onNew} onClone={lifecycle.clone.show}
          onOpenOverleaf={onOpenOverleaf} onOpenTutorial={lifecycle.openTutorialProject} onExportZip={lifecycle.exportProjectZip}
          onExportArxiv={onExportArxiv} onSettings={() => onSettings(triggerRef.current)}
        />
      </LazyMount>
    </DropdownMenu>
  );
  // A window holding one project shows its title alone, as it always has.
  const tabbed = projects.length > 1 && projects.some((entry) => entry.root === project.root);
  return (
    <header className={bar} onMouseDown={beginWindowDrag} onDoubleClick={titleBarDoubleClick}>
      <div className="titlebar-sidebar">
        <div className="titlebar-navigator">
          <div className="traffic-space" />
        </div>
        <div className="project-switcher">
          {tabbed ? (
            <Suspense fallback={projectTitle}>
              <ProjectTabs
                projects={projects} active={project.root} activeTab={projectTitle} actions={lifecycle}
                disabled={Boolean(lifecycle.busyLabel)}
              />
            </Suspense>
          ) : projectTitle}
          <div className="titlebar-drag-area" aria-hidden="true" />
        </div>
      </div>
      <div className="titlebar-main">
        {panelControls}
        {canvasToolbar}
      </div>
    </header>
  );
}
