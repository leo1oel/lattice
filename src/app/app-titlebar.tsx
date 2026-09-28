/**
 * The window title bar: the sidebar toggle and project switcher over the
 * sidebar's column, then the editor tab strip, the canvas toolbar and the build
 * button over the canvas.
 *
 * The canvas toolbar arrives as an element rather than as props. It reads about
 * fifty of App's values — collaboration presence, Overleaf channel state, the
 * dirty flags of both panes — and none of the rest of the title bar needs any
 * of them, so pulling them through here would double the interface for a
 * component that only ever gets slotted into one place.
 */
import { type ComponentProps, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Check,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Square,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { StateSwap } from "../components/ui/motion";
import { DropdownMenu, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { EditorTabs } from "../canvas/editor-tabs";
import { ProjectMenu } from "../project/project-dialogs";
import { beginWindowDrag, toggleWindowFullscreen } from "../app-utils";
import type { BuildPreferences } from "../settings/app-settings";
import type { CompileProject, ProjectSnapshot } from "../app-types";
import type { BuildPipeline } from "./use-build-pipeline";
import type { WorkspaceSidebar } from "./use-workspace-sidebar";

export function AppTitlebar({ project, sidebar, buildPipeline, buildPreferences, compile, tabs, projectMenu, canvasToolbar }: {
  project: ProjectSnapshot;
  sidebar: Pick<WorkspaceSidebar, "sidebarOpen" | "setSidebarOpen" | "sidebarWidth" | "sidebarResizing">;
  buildPipeline: Pick<BuildPipeline, "build" | "building" | "cleaning" | "abortBuild" | "cleanAndRebuild">;
  buildPreferences: BuildPreferences;
  compile: CompileProject;
  tabs: ComponentProps<typeof EditorTabs>;
  /** The project switcher's menu, plus whether it is open and what may disable it. */
  projectMenu: Omit<ComponentProps<typeof ProjectMenu>, "currentPath"> & {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    importing: boolean;
  };
  canvasToolbar: ReactNode;
}) {
  const { t } = useLingui();
  const { build, building } = buildPipeline;
  const buildSeconds = build ? (build.durationMs / 1000).toFixed(1) : "";
  const { sidebarOpen } = sidebar;
  const { open: menuOpen, setOpen: setMenuOpen, importing, ...menu } = projectMenu;
  return (
    <header className="titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
      <div className={`titlebar-sidebar ${sidebarOpen ? "" : "collapsed"}`} style={{ width: sidebarOpen ? sidebar.sidebarWidth + 1 : undefined }}>
        <div className="titlebar-navigator">
          <div className="traffic-space" />
          <div className="titlebar-sidebar-toggle">
            <Tip label={sidebarOpen ? t`Hide sidebar` : t`Show sidebar`}>
              <button className="icon-button" onClick={() => sidebar.setSidebarOpen((value) => !value)}>
                <span key={sidebarOpen ? "open" : "closed"} className="toggle-icon">
                  {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </span>
              </button>
            </Tip>
          </div>
        </div>
        <div className="project-switcher">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                className="project-title"
                aria-label={t`Switch project`}
                disabled={building || importing}
              >
                <span>{project.manifest.name}</span>
                <ChevronDown size={13} />
              </button>
            </DropdownMenuTrigger>
            <ProjectMenu currentPath={project.root} {...menu} />
          </DropdownMenu>
          <div className="titlebar-drag-area" aria-hidden="true" />
        </div>
      </div>
      <div className="titlebar-main">
        <EditorTabs {...tabs} />
        {canvasToolbar}
        <div className="title-actions">
          <Tip label={building ? t`Stop the current LaTeX build` : buildPreferences.autoBuildMode === "automatic"
            ? t`Build automatically · Command-S builds now. Shift-click for clean rebuild`
            : t`Build only when requested · Command-S builds now. Shift-click for clean rebuild`}
          >
            <button
              aria-label={building ? t`Stop` : t`Build`}
              data-tour="build"
              className={`build-button ${building ? "stop" : build?.success ? "success" : ""}`}
              onClick={(event) => {
                if (building) void buildPipeline.abortBuild();
                else if (event.shiftKey) void buildPipeline.cleanAndRebuild();
                else void compile(false, true);
              }}
              disabled={!building && buildPipeline.cleaning}
              aria-live="polite"
            >
              <StateSwap swapKey={building ? "building" : build?.success ? "success" : "idle"}>
                { }
                {building ? <Square size={13} fill="currentColor" /> : build?.success ? <Check size={15} /> : <Play size={15} />}
                <span className="build-button-label">
                  {building ? t`Stop` : build?.success ? t`${buildSeconds}s` : t`Build`}
                </span>
              </StateSwap>
            </button>
          </Tip>
        </div>
      </div>
    </header>
  );
}
